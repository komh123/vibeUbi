/**
 * run.mjs — one command from a working tree to a verified deploy, or back.
 *
 * This file is I/O and ORDER. Every decision belongs to the kernel, and that
 * separation is the reason any of it can be trusted:
 *
 *   is this step's output evidence that tests ran?   testRanVerdict
 *   can every layer we intend to use actually run?   prereqVerdict
 *   can this adapter prove a deploy at all?          proofContract
 *   did the deploy take?                             deployProof
 *   is this red ours?                                attributedVerdict
 *   ship or roll back?                               verdictFor
 *
 * ORDER IS A SAFETY PROPERTY, not a preference:
 *
 *   · `proofContract` runs FIRST, before anything is built. An adapter that
 *     cannot produce outside evidence is stopped at wiring time — not
 *     discovered after production has already changed twice.
 *   · `prereqVerdict` runs before the first mutation, because a layer that
 *     cannot answer would later read as `error`, and an error rolls back. A
 *     missing browser must not be able to manufacture an incident.
 *   · the tree hash is taken at verify and CHECKED AT SWAP. The tree is the
 *     deployment; if someone saved a file in between, the proof you just spent
 *     minutes on was about a different tree.
 *   · rollback is not finished when the files move back. It is finished when
 *     the running service is observed serving the old artifact.
 */
import { execFile, spawn } from "node:child_process"
import { mkdir, writeFile, readFile, rm } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { promisify } from "node:util"
import {
  verdictFor, earlyVerdict, gateCells, deployProof, proofContract,
  prereqVerdict, testRanVerdict, attributedVerdict, budgetVerdict,
  nodeHeapMb, heapOomMessage, HEAP_FLOOR_MB,
} from "../../kernel/src/index.mjs"
const exec = promisify(execFile)

export const SHIP_STEPS = [
  { id: "verify",  mutates: false, what: "typecheck, unit suites (each must show it actually ran tests), offline layers" },
  { id: "build",   mutates: false, what: "build into a scratch directory — never into the live one" },
  { id: "swap",    mutates: true,  what: "refuse if the tree changed since verify, then rename into place keeping the old build, and restart" },
  { id: "prove",   mutates: false, what: "observe, from OUTSIDE the process, that the running service serves the new artifact" },
  { id: "sweep",   mutates: false, what: "the layers, against the running site" },
  { id: "gate",    mutates: true,  what: "any P0 red or errored layer → roll back, and prove the rollback" },
  { id: "report",  mutates: false, what: "write the evidence" },
]

/** Budgets: at least 5 minutes, and 6×–40× the worst observed time. */
/** Measured on real runs. Re-measure rather than widen: a budget you raise
 *  because something got slow stops being a limit. */
export const OBSERVED_MS = { verify: 60_000, build: 90_000, swap: 20_000, prove: 15_000, sweep: 60_000, gate: 30_000, report: 8_000 }
/** At least 5 minutes, at least 6x the worst observed, no more than 40x. */
export const BUDGET_MS   = { verify: 600_000, build: 900_000, swap: 300_000, prove: 300_000, sweep: 600_000, gate: 300_000, report: 300_000 }

/**
 * The content hash of the tree right now.
 *
 * Not `git status` — a working tree like this is always dirty, so "clean" is
 * the wrong question. The question is whether it is the SAME tree as five
 * minutes ago, because the tree IS the deployment.
 *
 * BUILD OUTPUT IS EXCLUDED, and getting that wrong once made this gate refuse
 * every single ship: the build writes `dist-new/` into the tree, so the hash
 * taken after it could never match the one taken before. The drift this is
 * looking for is a HUMAN saving a file mid-run — the build doing its job is
 * not drift, and a gate that fires on correct behaviour gets deleted.
 */
export const TREE_EXCLUDE = ["dist", "dist-new", "dist-prev", ".next", ".next-new", ".next-prev", ".vibeubi", "node_modules", "coverage"]

export async function treeHash(root, exclude = TREE_EXCLUDE) {
  try {
    const idx = join(root, ".vibeubi", "index")
    await mkdir(join(root, ".vibeubi"), { recursive: true })
    // A FRESH index every time. Reusing one made the hash differ between two
    // consecutive calls on an unchanged tree — `add -A` against an index that
    // already had paths removed from it is not the same operation as `add -A`
    // against an empty one. A drift check that reports drift on an identical
    // tree is worse than no drift check: it teaches people to ignore it.
    await rm(idx, { force: true })
    const env = { ...process.env, GIT_INDEX_FILE: idx }
    // Add everything (this already respects .gitignore), then drop the build
    // output from the temporary index.
    //
    // NOT `:(exclude)` pathspecs: naming an ignored path in a pathspec makes
    // `git add` exit 1 with "the following paths are ignored", and this
    // function swallows failures as "no drift" — so the whole drift check went
    // silently dead while printing a green tick. A check that fails open must
    // never fail for a reason this boring.
    await exec("git", ["-C", root, "add", "-A"], { env, maxBuffer: 32 * 1024 * 1024 })
    await exec("git", ["-C", root, "rm", "-r", "--cached", "--quiet", "--ignore-unmatch", "--", ...exclude],
      { env, maxBuffer: 32 * 1024 * 1024 }).catch(() => {})
    const { stdout } = await exec("git", ["-C", root, "write-tree"], { env })
    return stdout.trim()
  } catch {
    // No git, shallow, no permission: "do not know" must read as "no drift",
    // because a gate that is always red on someone else's machine does not
    // exist. The cost of that choice is that a boring failure here turns the
    // check off silently — which already happened once — so anything that can
    // fail for a boring reason has to be fixed, not caught.
    return ""
  }
}

/**
 * What this machine will actually give a sub-step, in MB.
 *
 * The I/O half of `nodeHeapMb`, kept apart from it so the formula can be tested
 * against machine shapes this machine does not have.
 */
export async function machineMemory() {
  const readNum = async (p) => { try { return Number((await readFile(p, "utf8")).trim()) } catch { return NaN } }
  let cgroupLimitMb = null
  for (const [path, div] of [["/sys/fs/cgroup/memory.max", 1], ["/sys/fs/cgroup/memory/memory.limit_in_bytes", 1]]) {
    const v = await readNum(path)
    // cgroup v2 writes the string "max" when unlimited; v1 writes a number so
    // large it means the same thing. Both must read as "no fence", not as a
    // fence of 8 exabytes.
    if (Number.isFinite(v) && v > 0 && v < 2 ** 53 / 2) { cgroupLimitMb = Math.floor(v / div / 1024 / 1024); break }
  }
  let availableMb = 0
  try {
    const mi = await readFile("/proc/meminfo", "utf8")
    availableMb = Math.floor(Number(/MemAvailable:\s+(\d+)/.exec(mi)?.[1] ?? 0) / 1024)
  } catch { /* not linux */ }
  if (!availableMb) { const os = await import("node:os"); availableMb = Math.floor(os.freemem() / 1024 / 1024) }
  return { cgroupLimitMb, availableMb }
}

/**
 * Run one verify step, with a heap ceiling and a kill that reaches the tree.
 *
 * Both of those were missing, and both are the PIPELINE's problem rather than
 * any project's: a peer session measured node's default old-space at 4144 MB
 * and its project's `tsc --noEmit` peak at 5318 MB — a guaranteed OOM, and of
 * its fifteen node sub-steps exactly zero had a ceiling. Every project's peak
 * crosses 4144 MB eventually.
 *
 * Three changes, each for its own reason:
 *
 * - `spawn` DETACHED, and the timeout kills the process GROUP. `execFile`'s
 *   killSignal reaches only the child we hold, so a test runner's workers and
 *   a tsc server survive their own parent and keep the machine busy.
 * - stdio goes straight to the file. The old comment claimed output never went
 *   through a pipe; `execFile` piped it with a 64 MB buffer, so the hazard the
 *   comment warned about was still there — a noisy suite fills the buffer and
 *   the child blocks, which reads on screen as "slow".
 * - a V8 OOM gets `heapOomMessage` instead of the raw stack, because the raw
 *   stack sends operators to the machine's memory, which is not what ran out.
 */
async function runStep(id, cmd, args, { cwd, outDir, timeoutMs, heapMb = null, env = {} }) {
  const t0 = Date.now()
  const file = join(outDir, `step-${id.replace(/[^\w.-]/g, "_")}.out`)
  const { openSync, readFileSync } = await import("node:fs")
  const fd = openSync(file, "a")

  const nodeOpts = [process.env.NODE_OPTIONS, heapMb ? `--max-old-space-size=${heapMb}` : ""]
    .filter(Boolean).join(" ")

  const child = spawn(cmd, args, {
    cwd, detached: true, stdio: ["ignore", fd, fd],
    env: { ...process.env, ...env, ...(nodeOpts ? { NODE_OPTIONS: nodeOpts } : {}) },
  })

  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    // The decision (kill the whole tree) lives in the kernel; this is only the
    // POSIX mechanism for it. A negative pid addresses the group.
    try { process.kill(-child.pid, "SIGKILL") } catch { try { child.kill("SIGKILL") } catch { /* already gone */ } }
  }, timeoutMs)

  const code = await new Promise((resolve) => {
    child.on("error", () => resolve(127))
    child.on("exit", (c, sig) => resolve(c ?? (sig ? 1 : 0)))
  })
  clearTimeout(timer)
  try { (await import("node:fs")).closeSync(fd) } catch { /* already closed */ }

  let out = ""
  try { out = readFileSync(file, "utf8") } catch { /* nothing was written */ }
  const oom = heapOomMessage({ output: out, step: id, heapMb, availableMb: env.__availableMb ?? 0 })
  return { code, out, timedOut, oom, ms: Date.now() - t0 }
}

/**
 * @param {object} o
 * @param {(e:object)=>void} o.emit  every step, verdict and line goes through here
 */
export async function ship({ root, config, target, discovered = [], emit = () => {}, opts = {} }) {
  const started = Date.now()
  const outDir = join(root, ".vibeubi", `ship-${new Date().toISOString().replace(/[:.]/g, "-")}`)
  await mkdir(outDir, { recursive: true })
  const say = (kind, msg, extra = {}) => emit({ kind, msg, at: Date.now() - started, ...extra })
  const step = (n, id, state, extra = {}) => emit({ kind: "step", n, id, state, ...extra })

  const finish = (outcome, reason) => {
    emit({ kind: "done", outcome, reason, outDir, ms: Date.now() - started })
    return { outcome, reason, outDir }
  }

  /* ── 0 · can this adapter prove anything at all? ─────────────────────── */
  const contract = proofContract(target.proofClaim ?? {})
  if (!contract.ok) {
    for (const s of SHIP_STEPS) step(SHIP_STEPS.indexOf(s), s.id, "unreached")
    say("bad", contract.reason)
    say("bad", target.proofClaim?.source ?? "")
    return finish("refused", "proof contract: " + contract.reason)
  }
  say("ok", `proof: ${target.proofClaim.source}`)

  /* ── budgets are a registry too ──────────────────────────────────────── */
  /**
   * A project may set its own budgets, and until now it could not.
   *
   * `BUDGET_MS` was a module constant read directly at the call site, so
   * `config.budgets` was a field anyone could write and nothing would consume —
   * the same shape as every other defect found this week. It surfaced as a test
   * that set a 1.5s verify budget and then sat there for the module's 600s.
   */
  const budgetMs = { ...BUDGET_MS, ...(config.budgets ?? {}) }
  const budgets = budgetVerdict({ clocked: SHIP_STEPS.map((s) => s.id), budgets: budgetMs, observed: OBSERVED_MS })
  if (!budgets.ok) say("warn", budgets.reason)

  /* ── 1 · verify ──────────────────────────────────────────────────────── */
  step(0, "verify", "run")
  say("head", "1/7  verify — nothing is built until this is green")

  const checks = config.verify ?? []
  if (checks.length === 0) say("warn", "no verify steps configured — this ship proves nothing about the code")

  /**
   * One ceiling, decided once, for every node sub-step.
   *
   * Without it each step inherits node's default old-space — 4144 MB on the
   * machine where this was measured — and a project whose type graph outgrows
   * that gets a guaranteed OOM that looks exactly like a broken test suite.
   * `config.heapMb` overrides for a project that knows better than the formula.
   */
  /**
   * `config.memory` overrides what we read off the machine.
   *
   * Not test plumbing: in CI the cgroup files frequently describe the HOST and
   * not the container the step is actually confined to, so the number read here
   * can be an order of magnitude wrong in the dangerous direction. A project
   * that knows its own limit should be able to say so.
   */
  const mem = { ...(await machineMemory()), ...(config.memory ?? {}) }
  const heap = config.heapMb
    ? { heapMb: config.heapMb, fenced: !!mem.cgroupLimitMb, why: "set explicitly in this project's config" }
    : nodeHeapMb({ ...mem, reserveMb: config.reserveMb ?? 2048 })
  if (checks.length) say("dim", `each node step gets --max-old-space-size=${heap.heapMb} — ${heap.why}`)

  /**
   * A fence below our own floor is a refusal, not a warning.
   *
   * This printed a warning and then ran the step anyway, which the peer session
   * that contributed the formula caught: a 100 MB fence derives a 75 MB heap,
   * node will not run a type-check in that, and the operator gets a confusing
   * crash instead of a clear "this does not fit here". `tooSmall` was a field
   * whose only reader printed it — a control that looks like a control, which
   * is the defect class both of us have now been bitten by five times between us.
   *
   * Refusing is also where this belongs: verify is the step that is allowed to
   * stop the run, because nothing has been mutated yet.
   */
  if (heap.tooSmall && checks.length) {
    step(0, "verify", "fail")
    say("bad", heap.why)
    say("dim", `raise the memory limit on this container, or set heapMb explicitly if you know this step fits in less than ${HEAP_FLOOR_MB} MB`)
    return finish("refused", `the memory fence (${heap.numbers?.cgroupLimitMb} MB) is below this pipeline's floor`)
  }

  for (const c of checks) {
    const [bin, ...args] = c.cmd.split(/\s+/)
    const r = await runStep(c.name, bin, args, {
      cwd: root, outDir, timeoutMs: budgetMs.verify,
      heapMb: heap.heapMb, env: { __availableMb: mem.availableMb },
    })
    if (r.timedOut) { step(0, "verify", "fail"); say("bad", `${c.name} hung past its budget — a hang is a named failure, not a slow day`); return finish("refused", `${c.name} timed out`) }
    if (r.code !== 0) {
      step(0, "verify", "fail")
      // A V8 OOM is not "the tests failed", and saying so sends people to the
      // wrong place for an hour. It is also self-locking, which is why the
      // second run looks identical and the machine gets blamed.
      if (r.oom) { say("bad", r.oom); return finish("refused", `${c.name} ran out of heap`) }
      say("bad", `${c.name} failed`); say("dim", tail(r.out)); return finish("refused", `${c.name} failed`)
    }
    if (c.expectsTests) {
      // Exit 0 is not enough. "No bad news" is not "good news".
      const ran = testRanVerdict(c.name, r.out)
      if (!ran.ok) { step(0, "verify", "fail"); say("bad", ran.reason); return finish("refused", `${c.name} proved nothing`) }
      say("ok", `${c.name}  ${(r.ms / 1000).toFixed(0)}s · ${ran.passed} pass`)
    } else {
      say("ok", `${c.name}  ${(r.ms / 1000).toFixed(0)}s`)
    }
  }

  /* ── every layer we intend to use must be able to run, BEFORE we mutate ── */
  const wanted = config.layers ?? ["S0", "S2", "S4"]
  const pre = prereqVerdict(wanted, config.prereqs ?? wanted.map((l) => ({ layer: l, ok: true })), config.allowDegraded ?? [])
  if (!pre.proceed) { step(0, "verify", "fail"); say("bad", pre.reason); return finish("refused", pre.reason) }
  for (const d of pre.degraded ?? []) say("warn", `${d.layer} degraded by choice: ${d.reason}`)
  say("ok", `all ${pre.layers.length} layer(s) can run`)

  const treeAtVerify = await treeHash(root)
  step(0, "verify", "pass")

  /* ── 2 · build ───────────────────────────────────────────────────────── */
  step(1, "build", "run")
  say("head", "2/7  build into a scratch directory")
  let artifactId = ""
  try {
    const b = await target.build?.()
    if (b?.skipped) say("warn", `build skipped: ${b.skipped}`)
    artifactId = await target.artifactId()
  } catch (err) {
    step(1, "build", "fail"); say("bad", String(err.message)); return finish("refused", "build failed")
  }
  if (!artifactId) { step(1, "build", "fail"); say("bad", "the build produced no artifact id — nothing to prove later"); return finish("refused", "no artifact id") }
  say("ok", `artifact ${artifactId}`)
  step(1, "build", "pass")

  /* ── 3 · swap ────────────────────────────────────────────────────────── */
  step(2, "swap", "run")
  say("head", "3/7  swap")
  const treeAtSwap = await treeHash(root)
  if (treeAtVerify && treeAtSwap && treeAtVerify !== treeAtSwap) {
    step(2, "swap", "fail")
    say("bad", "the working tree changed since verify. The tree IS the deployment, so that proof was about a different tree.")
    return finish("refused", "tree drift between verify and swap")
  }
  say("ok", treeAtVerify ? "tree hash unchanged since verify" : "tree hash unavailable — treated as no drift")

  let previousId = null
  try { previousId = await target.previousArtifactId?.({ base: config.base }) ?? null } catch { /* first deploy */ }

  try {
    await target.swap()
    await target.restart?.()
  } catch (err) {
    step(2, "swap", "fail"); say("bad", String(err.message)); return finish("refused", "swap failed")
  }
  say("ok", `swapped${previousId ? ` ${previousId} → ${artifactId}` : ""}`)
  step(2, "swap", "pass")

  /* ── 4 · prove — the only evidence accepted ──────────────────────────── */
  step(3, "prove", "run")
  say("head", "4/7  prove — from OUTSIDE the deployed process")
  const proof = deployProof(
    await readyObservation({ target, config, expected: artifactId, previous: previousId, say }),
  )
  if (!proof.ok) {
    step(3, "prove", "fail")
    say("bad", proof.reason)
    say("warn", "rolling back — the deploy could not be shown to have happened")
    const r = await rollbackAndProve({ target, config, artifactId, previousId, say })
    step(5, "gate", r.ok ? "pass" : "fail")
    step(4, "sweep", "unreached"); step(6, "report", "pass")
    return finish(r.ok ? "rolled back" : "rollback unproven", proof.reason)
  }
  say("ok", `the running service serves ${artifactId}`)
  step(3, "prove", "pass")

  /* ── 5 · sweep ───────────────────────────────────────────────────────── */
  step(4, "sweep", "run")
  say("head", "5/7  sweep — judged the moment each cell is known")
  const cells = []
  let stopped = null
  for await (const cell of config.sweep({ root, config, base: config.base, discovered })) {
    cells.push(cell)
    emit({ kind: "cell", cell })
    if (cell.status === "fail" && cell.priority === "P0") say("bad", `${cell.feature} · ${cell.layer} — ${cell.reason}`)
    const early = earlyVerdict(cells)
    if (early.stop && !stopped) { stopped = early.verdict; break }
  }
  step(4, "sweep", stopped ? "fail" : "pass")

  /* ── 6 · gate ────────────────────────────────────────────────────────── */
  step(5, "gate", "run")
  say("head", "6/7  gate")
  const all = gateCells({ cells, degraded: (pre.degraded ?? []).map((d) => d.layer) })
  let verdict = verdictFor(all)

  if (!verdict.ship && config.recheck) {
    // The gate's whole justification is that undoing the deploy undoes the
    // problem. A red that also fails on the build being rolled back TO fails
    // that test — so re-check once, and REPORT what gets exonerated.
    say("warn", "P0 red — re-checking once to find out whose fault it is")
    const again = await config.recheck(verdict.blocking)
    const attributed = attributedVerdict(all, again)
    for (const c of attributed.exonerated) say("warn", `exonerated (not this deploy): ${c.feature} · ${c.layer}`)
    verdict = attributed
  }

  if (!verdict.ship) {
    say("bad", verdict.reason)
    const r = await rollbackAndProve({ target, config, artifactId, previousId, say })
    step(5, "gate", r.ok ? "pass" : "fail"); step(6, "report", "pass")
    await writeReport(outDir, { artifactId, previousId, cells: all, verdict, outcome: r.ok ? "rolled back" : "rollback unproven" })
    return finish(r.ok ? "rolled back" : "rollback unproven", verdict.reason)
  }
  say("ok", verdict.reason)
  step(5, "gate", "pass")

  /* ── 7 · report ──────────────────────────────────────────────────────── */
  step(6, "report", "run")
  await writeReport(outDir, { artifactId, previousId, cells: all, verdict, outcome: "shipped" })
  step(6, "report", "pass")
  say("head", `7/7  report ${outDir}`)
  return finish("shipped", verdict.reason)
}

/** A rollback is not done when the files move. It is done when the old
 *  artifact is OBSERVED serving again. */
/**
 * Observe the running service, waiting for it to be up — but judging it once.
 *
 * `restart` waits a fixed 1.2s and then checks the process is ALIVE, which is
 * not the same as SERVING. Measured on this machine: an app that takes 1.5s to
 * bind is still down 500ms after restart returns. `proof` was a single fetch,
 * so it fired into a closed port, threw ECONNREFUSED, and the deploy was rolled
 * back — a healthy app, rejected for booting slowly. A gate that punishes the
 * correct thing is worse than no gate.
 *
 * The distinction this function is built around: IT RETRIES THE OBSERVATION,
 * NOT THE VERDICT. It returns whatever it last saw and `deployProof` judges
 * that once, by rules this function cannot reach. A deploy that never takes
 * still fails — it just fails at the deadline instead of instantly, and says
 * how long it waited. Nothing here can turn a red into a green; the only thing
 * it can change is judging an answer the service had not given yet.
 *
 * Waiting on a mismatch, not just on a refusal, is deliberate: a swap whose old
 * process is still holding the port serves the OLD id, which is indistinguishable
 * at t=0 from a new process that has not finished booting.
 */
export async function readyObservation({ target, config, expected, previous, say = () => {}, readyMs = config?.proveReadyMs ?? 15_000, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const deadline = now() + Math.max(0, readyMs)
  let last = { expected, previous, observed: "" }
  let waited = false
  for (let attempt = 1; ; attempt++) {
    try {
      last = await target.proof({ base: config.base, expected, previous })
      if (deployProof(last).ok) {
        if (waited) say("ok", `the service answered after ${attempt} attempts`)
        return last
      }
    } catch (err) {
      // Keep the reason: if the deadline passes, this is what the operator needs.
      last = { expected, previous, observed: "", unreachable: err.message }
    }
    if (now() >= deadline) {
      if (waited) say("warn", `waited ${Math.round(readyMs / 1000)}s for the service and it never served ${expected}`)
      return last
    }
    if (!waited) { waited = true; say("warn", `the service is not answering with ${expected} yet — waiting up to ${Math.round(readyMs / 1000)}s`) }
    await sleep(250)
  }
}

async function rollbackAndProve({ target, config, artifactId, previousId, say }) {
  try {
    await target.rollback()
    await target.restart?.()
  } catch (err) {
    say("bad", `ROLLBACK FAILED: ${err.message}`)
    return { ok: false }
  }
  if (!previousId) { say("warn", "rolled back, but there was no previous artifact id to prove against"); return { ok: false } }
  try {
    const observed = await target.proof({ base: config.base, expected: previousId, previous: artifactId })
    const p = deployProof(observed)
    if (p.ok) { say("ok", `the running service serves ${previousId} again — rollback PROVED`); return { ok: true } }
    say("bad", `ROLLBACK UNPROVEN: ${p.reason}`)
    return { ok: false }
  } catch (err) {
    say("bad", `ROLLBACK UNPROVEN: could not observe the service: ${err.message}`)
    return { ok: false }
  }
}

async function writeReport(outDir, data) {
  await writeFile(join(outDir, "report.json"), JSON.stringify({ ...data, at: new Date().toISOString() }, null, 2), "utf8")
}

const tail = (s, n = 18) => String(s).trim().split("\n").slice(-n).join("\n")
