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
import { execFile } from "node:child_process"
import { mkdir, writeFile, readFile, rm } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { promisify } from "node:util"
import {
  verdictFor, earlyVerdict, gateCells, deployProof, proofContract,
  prereqVerdict, testRanVerdict, attributedVerdict, budgetVerdict,
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

async function runStep(id, cmd, args, { cwd, outDir, timeoutMs }) {
  const t0 = Date.now()
  let out = "", code = 0, timedOut = false
  try {
    const r = await exec(cmd, args, { cwd, timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 64 * 1024 * 1024 })
    out = r.stdout + r.stderr
  } catch (err) {
    out = (err.stdout ?? "") + (err.stderr ?? "") + (err.message ?? "")
    code = err.code ?? 1
    timedOut = err.killed === true || /ETIMEDOUT/.test(String(err.code))
  }
  // Output goes to a FILE, never through a pipe. A noisy suite fills a pipe's
  // buffer and the child blocks forever, which reads on screen as "slow".
  await writeFile(join(outDir, `step-${id.replace(/[^\w.-]/g, "_")}.out`), out, "utf8")
  return { code, out, timedOut, ms: Date.now() - t0 }
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
  const budgets = budgetVerdict({ clocked: SHIP_STEPS.map((s) => s.id), budgets: BUDGET_MS, observed: OBSERVED_MS })
  if (!budgets.ok) say("warn", budgets.reason)

  /* ── 1 · verify ──────────────────────────────────────────────────────── */
  step(0, "verify", "run")
  say("head", "1/7  verify — nothing is built until this is green")

  const checks = config.verify ?? []
  if (checks.length === 0) say("warn", "no verify steps configured — this ship proves nothing about the code")
  for (const c of checks) {
    const [bin, ...args] = c.cmd.split(/\s+/)
    const r = await runStep(c.name, bin, args, { cwd: root, outDir, timeoutMs: BUDGET_MS.verify })
    if (r.timedOut) { step(0, "verify", "fail"); say("bad", `${c.name} hung past its budget — a hang is a named failure, not a slow day`); return finish("refused", `${c.name} timed out`) }
    if (r.code !== 0) { step(0, "verify", "fail"); say("bad", `${c.name} failed`); say("dim", tail(r.out)); return finish("refused", `${c.name} failed`) }
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
  let proof
  try {
    const observed = await target.proof({ base: config.base, expected: artifactId, previous: previousId })
    proof = deployProof(observed)
  } catch (err) {
    proof = { ok: false, reason: `could not observe the running service: ${err.message}` }
  }
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
