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
  nodeHeapMb, heapOomMessage, ceilingEffect, HEAP_FLOOR_MB,
  proofDiscrimination, trimProofHistory, runtimeFloorVerdict,
  probeOrder, orderVerdict,
} from "../../kernel/src/index.mjs"
const exec = promisify(execFile)

export const SHIP_STEPS = [
  { id: "verify",  mutates: false, what: "typecheck, unit suites (each must show it actually ran tests), offline layers" },
  { id: "build",   mutates: false, what: "build into a scratch directory — never into the live one" },
  { id: "swap",    mutates: true,  what: "refuse if the tree changed since verify, then rename into place keeping the old build, and restart" },
  { id: "prove",   mutates: false, what: "observe, from OUTSIDE the process, that the running service serves the new artifact" },
  { id: "sweep",   mutates: false, what: "the layers, against the running site" },
  { id: "gate",    mutates: true,  what: "any P0 red or errored layer → roll back, and prove the rollback" },
  { id: "probe",   mutates: true,  what: "hand a SKILL the registry's P0 pages, judge what it reports, roll back on a P0 red" },
  { id: "report",  mutates: false, what: "write the evidence" },
]

/** Budgets: at least 5 minutes, and 6×–40× the worst observed time. */
/** Measured on real runs. Re-measure rather than widen: a budget you raise
 *  because something got slow stops being a limit. */
export const OBSERVED_MS = { verify: 60_000, build: 90_000, swap: 20_000, prove: 15_000, sweep: 60_000, gate: 30_000, probe: 120_000, report: 8_000 }
/** At least 5 minutes, at least 6x the worst observed, no more than 40x. */
export const BUDGET_MS   = { verify: 600_000, build: 900_000, swap: 300_000, prove: 300_000, sweep: 600_000, gate: 300_000, probe: 1_800_000, report: 300_000 }

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
  const oom = heapOomMessage({ output: out, forStep: id, heapMb, availableMb: env.__availableMb ?? 0 })
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
  /**
   * The ceiling is decided PER STEP, even though today every step shares one
   * machine-wide fence.
   *
   * A peer session warned that a refusal checked at a single call site lets a
   * more tightly fenced later step slip past the door — and looking for that
   * found something worse in this tree: `build` spawned the project's build
   * command with NO ceiling at all, no timeout and no tree kill, while `verify`
   * had all three. A Next.js or Vite build is the single step most likely to
   * exhaust a heap, so the one step that most needed the guard was the one
   * without it.
   *
   * `config.heapMb` may be a number (all steps) or a map keyed by step id, so
   * a project that really does fence one step tighter gets the refusal too
   * rather than silently getting a heap its fence will kill.
   */
  const heapFor = (stepId) => {
    const override = typeof config.heapMb === "object" ? config.heapMb?.[stepId] : config.heapMb
    if (override) return { heapMb: override, fenced: !!mem.cgroupLimitMb, reason: "configured", numbers: { heapMb: override }, why: `set explicitly for ${stepId} in this project's config` }
    const fence = config.fences?.[stepId] ?? mem.cgroupLimitMb
    return nodeHeapMb({ cgroupLimitMb: fence, availableMb: mem.availableMb, reserveMb: config.reserveMb ?? 2048 })
  }
  const heap = heapFor("verify")
  if (checks.length) say("dim", `each node step gets --max-old-space-size=${heap.heapMb} — ${heap.why}`)
  /**
   * Say so when the ceiling is not actually a ceiling.
   *
   * V8 sizes old-space from the machine, so the formula can land on the default
   * — around 7.5 GB available it derives ~4096, which on this machine IS the
   * default. Reporting "each node step gets a 4096 MB ceiling" while imposing
   * nothing is the same lie as a build script that has carried that flag for
   * months. The number is not wrong; the claim about it would be.
   */
  {
    const v8 = await import("node:v8")
    const defaultOldSpaceMb = Math.round(v8.getHeapStatistics().heap_size_limit / 1024 / 1024) - 48
    const eff = ceilingEffect(heap.heapMb, defaultOldSpaceMb)
    if (checks.length && eff.worse) {
      say("warn",
        `verify was given ${heap.heapMb} MB, and this machine gives node ${defaultOldSpaceMb} MB with no flag at all — ` +
        `so this ceiling is LOWER than the default. The step is more likely to run out of heap with this pipeline than without it. ` +
        `Wait for the machine to be quieter, or set heapMb explicitly.`)
    } else if (checks.length && eff.ineffective) {
      say("warn",
        `${heap.heapMb} MB is node's own default on this machine (~${defaultOldSpaceMb} MB), so this flag imposes nothing. ` +
        `The step is running on the default ceiling — raise the container's memory, or set heapMb explicitly, if it needs more.`)
    }
  }

  /**
   * Checked for EVERY step that will spawn something, not just this one.
   *
   * Refusing here rather than at each step is deliberate: verify is the last
   * point at which nothing has been mutated, so a fence that cannot host the
   * build is better reported now than after the swap.
   */
  const spawning = ["verify", "build", "sweep"]
  for (const id of spawning) {
    if (id === "verify" && checks.length === 0) continue
    const h = heapFor(id)
    if (!h.tooSmall) continue
    step(0, "verify", "fail")
    say("bad", `${id}: ${h.why}`)
    say("dim", `raise the memory limit on this container, or set heapMb explicitly if you know this step fits in less than ${HEAP_FLOOR_MB} MB`)
    return finish("refused", `the memory fence for ${id} (${h.numbers?.cgroupLimitMb} MB) is below this pipeline's floor`)
  }

  /**
   * Which node will the STEPS get — not which one is running this pipeline.
   *
   * A peer's machine has `type -P node` pointing at a wrapper hard-locked to
   * v18.19.1 that also makes nvm ineffective, so "I ran ship with node 22" and
   * "the steps ran on node 22" are different claims there. Checked before the
   * swap, where refusing is free.
   *
   * Narrow on purpose: only when the project DECLARES a floor and a step's
   * command actually invokes node. A check that fires on projects it knows
   * nothing about is the too-wide kind that gets deleted.
   */
  if (checks.some((c) => /\bnode\b/.test(c.cmd))) {
    const floor = await readFile(join(root, "package.json"), "utf8")
      .then((t) => JSON.parse(t).engines?.node).catch(() => null)
    if (floor) {
      const stepNode = await new Promise((r) => {
        const p = spawn("node", ["-p", "process.version"], { stdio: ["ignore", "pipe", "ignore"] })
        let out = ""
        p.stdout.on("data", (d) => (out += d))
        p.on("exit", () => r(out.trim() || null))
        p.on("error", () => r(null))
      })
      const rv = runtimeFloorVerdict({ step: "your verify steps", running: stepNode, floor })
      if (!rv.ok) {
        step(0, "verify", "fail")
        say("bad", rv.reason)
        say("dim", `this pipeline is on ${process.version}; what a step gets is a different question`)
        return finish("refused", `steps would run on ${stepNode ?? "an unreadable node"}, below ${floor}`)
      }
      say("dim", `steps will run on ${stepNode} (floor ${floor})`)
    }
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
    const bh = heapFor("build")
    say("dim", `build gets --max-old-space-size=${bh.heapMb}`)
    const b = await target.build?.({ heapMb: bh.heapMb, timeoutMs: budgetMs.build })
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
  const proofObserved = await readyObservation({ target, config, expected: artifactId, previous: previousId, say })
  const proof = deployProof(proofObserved)
  if (!proof.ok) {
    step(3, "prove", "fail")
    say("bad", proof.reason)
    say("warn", "rolling back — the deploy could not be shown to have happened")
    const r = await rollbackAndProve({ target, config, artifactId, previousId, say })
    step(5, "gate", r.ok ? "pass" : "fail")
    step(4, "sweep", "unreached"); step(6, "probe", "unreached"); step(7, "report", "pass")
    return finish(r.ok ? "rolled back" : "rollback unproven", proof.reason)
  }
  say("ok", `the running service serves ${artifactId}`)

  /**
   * Record what the proof SAID, and ask whether it can tell builds apart.
   *
   * `proofContract` checks the shape of the claim; this checks the field. A
   * peer's live endpoint carries both `commit: null` (same answer for every
   * build, for ever) and `buildId` (identifies the artifact) behind one
   * declared `versionPath` — so a shape check says yes and the yes is true of
   * one of them.
   *
   * It needs cross-deploy memory, which is the one thing this pipeline already
   * has: it looks at the running service every single ship.
   */
  try {
    const { readFile: rf, writeFile: wf } = await import("node:fs/promises")
    const histPath = join(root, ".vibeubi", "proof-history.json")
    const prior = await rf(histPath, "utf8").then(JSON.parse).catch(() => [])
    const observedNow = typeof proofObserved?.observed === "string" && proofObserved.observed.trim()
      ? proofObserved.observed.trim().slice(0, 200) : null
    const history = trimProofHistory([...prior, { artifactId, observed: observedNow, at: Date.now() }])
    await wf(histPath, JSON.stringify(history, null, 2), "utf8")

    const power = proofDiscrimination(history)
    if (power.verdict === "no-power" || power.verdict === "identifies-something-else") {
      // Not a refusal of THIS deploy — the deploy is fine and the evidence for
      // it is not. Said loudly, every time, because a proof that cannot tell
      // builds apart makes every future green tick meaningless.
      say("warn", `the deploy proof may not be evidence: ${power.reason}`)
    } else if (power.ok) {
      say("dim", `proof discriminates: ${power.reason}`)
    }
  } catch { /* history is an aid, never a gate — a broken file must not stop a ship */ }

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
  say("head", "6/8  gate")
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
    step(5, "gate", r.ok ? "pass" : "fail"); step(6, "probe", "unreached"); step(7, "report", "pass")
    await writeReport(outDir, { artifactId, previousId, cells: all, verdict, outcome: r.ok ? "rolled back" : "rollback unproven" })
    return finish(r.ok ? "rolled back" : "rollback unproven", verdict.reason)
  }
  say("ok", verdict.reason)
  step(5, "gate", "pass")

  /* ── 7 · probe — a SKILL checks what the registry says matters ───────── */
  /**
   * Deliberately AFTER the gate, and deliberately mutating.
   *
   * After, because this is the expensive step — a real browser over N pages —
   * and there is no reason to pay for it on a deploy that already failed for a
   * cheaper reason. Mutating, because a P0 red here rolls back for exactly the
   * same justification as a P0 red in the gate: undoing the deploy undoes the
   * problem. A step that could find a broken login page and then ship it anyway
   * would be a report, not a gate.
   *
   * The SKILL is a slot. `dom-test` is the default because its evidence
   * channels line up with what the registry already knows how to ask about;
   * nothing in this file knows what a browser is. Point `config.probe.skill` at
   * a security skill, an a11y skill, a performance skill — the order goes out
   * and the result comes back in the same shape.
   *
   * The pipeline does not RUN the skill. It writes an order, and the agent
   * driving this ship runs the skill and writes a result. Pretending the
   * pipeline could drive a browser well would produce a worse test: choosing
   * which invariants matter, telling a stale locator from a broken app, reading
   * a red channel — that is judgement, and this product's rule is that an agent
   * may widen what gets checked and may not move the pass mark.
   */
  let probeUnverified = 0
  const probeCfg = config.probe ?? {}
  if (probeCfg.skill !== false) {
    step(6, "probe", "run")
    const order = probeOrder({
      discovered, declared: config.declared ?? [], artifactId,
      base: config.base, skill: probeCfg.skill ?? "dom-test",
      only: probeCfg.only ?? ["P0"],
    })
    say("head", `7/8  probe — ${order.items.length} item(s) for ${order.skill}`)

    if (order.items.length === 0) {
      say("warn", `nothing to probe: no ${(probeCfg.only ?? ["P0"]).join("/")} page is both discovered and declared`)
      step(6, "probe", "pass")
    } else {
      const orderPath = join(outDir, "probe-order.json")
      await writeFile(orderPath, JSON.stringify(order, null, 2), "utf8")
      say("dim", `order written: ${orderPath}`)

      const result = await (probeCfg.fulfil
        ? probeCfg.fulfil(order)
        : readFile(join(outDir, "probe-result.json"), "utf8").then(JSON.parse).catch(() => null))

      /**
       * Look at the base ourselves before judging what the skill said about it.
       *
       * One request, trusting nobody. `prove` saw this artifact serving minutes
       * ago, so a base that is down NOW is the deploy, not the fixture — and
       * without this check the most dangerous case (a deploy that takes the
       * site down, so the skill honestly reports it could not load anything)
       * and the benign one (an expired test password) produce the same word.
       */
      const liveness = await fetch(config.base, { redirect: "manual" })
        .then((r) => ({ ok: r.status < 500, status: r.status }))
        .catch((e) => ({ ok: false, unreachable: e.cause?.code ?? e.message }))
      // And which artifact is it serving NOW? `prove` established this minutes
      // ago; anything else here means something replaced it in between, and the
      // skill's report — however true — is about a build that is gone.
      if (liveness.ok) {
        try {
          const seen = await target.proof({ base: config.base, expected: artifactId, previous: previousId })
          if (typeof seen?.observed === "string" && seen.observed.includes(artifactId)) liveness.artifact = artifactId
          else if (typeof seen?.observed === "string" && seen.observed.trim()) liveness.artifact = seen.observed.trim().slice(0, 120)
        } catch { /* the adapter could not look; the null case is already named */ }
      }
      if (!liveness.ok) say("bad", `base is not serving at probe time: ${liveness.unreachable ?? `HTTP ${liveness.status}`}`)

      const judged = orderVerdict({ order, result, liveness, noiseIsFailure: probeCfg.noiseIsFailure ?? true })
      for (const c of judged.cells) emit({ kind: "cell", cell: c })
      // The number that stops this step being decoration: an operator who reads
      // "shipped" has to also read how much of it was actually verified.
      say(judged.unverified === 0 ? "ok" : "warn",
        `${judged.verified}/${judged.ordered} item(s) verified` +
        (judged.unverified ? `, ${judged.unverified} unverified (could not be measured — the deploy stands)` : ""))
      for (const c of judged.cells.filter((x) => x.status === "blocked")) {
        say("warn", `  ${c.feature} — ${c.skillVerdict ?? "not reported"}: ${c.reason}`)
      }

      const probeVerdict = verdictFor(gateCells({ cells: judged.cells, degraded: [] }))
      if (!probeVerdict.ship) {
        say("bad", probeVerdict.reason)
        // "1 layer(s) errored" is a count, and a count is not a diagnosis. The
        // cell knows which item and why; print it, because the operator's first
        // line should not send them to a file to find out what broke.
        for (const c of judged.cells.filter((x) => x.status !== "pass")) {
          say("bad", `  ${c.feature} — ${c.skillVerdict ?? c.status}: ${c.reason}`)
        }
        step(6, "probe", "fail")
        const r = await rollbackAndProve({ target, config, artifactId, previousId, say })
        step(7, "report", "pass")
        await writeReport(outDir, { artifactId, previousId, cells: [...all, ...judged.cells], verdict: probeVerdict, outcome: r.ok ? "rolled back" : "rollback unproven" })
        return finish(r.ok ? "rolled back" : "rollback unproven", probeVerdict.reason)
      }
      say("ok", probeVerdict.reason)
      step(6, "probe", judged.unverified ? "pass" : "pass", { unverified: judged.unverified, verified: judged.verified })
      all.push(...judged.cells)
      if (judged.unverified) probeUnverified = judged.unverified
    }
  } else {
    step(6, "probe", "unreached")
    say("dim", "probe step disabled (probe.skill: false)")
  }

  /* ── 8 · report ──────────────────────────────────────────────────────── */
  step(7, "report", "run")
  await writeReport(outDir, { artifactId, previousId, cells: all, verdict, outcome: "shipped" })
  step(7, "report", "pass")
  say("head", `8/8  report ${outDir}`)
  return finish("shipped", probeUnverified
    ? `${verdict.reason} · ${probeUnverified} P0 page(s) could not be verified`
    : verdict.reason)
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
