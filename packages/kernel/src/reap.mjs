/**
 * reap.mjs — naming and reaping the objects a journey creates in production.
 *
 * Read-only layers only read. Before journeys existed, EVERY create path in
 * the product had never once been walked by the gate — which is exactly how a
 * two-day outage hid behind `200 {"docs":[]}` (a failed read folded into
 * "this user has no documents") with no layer saying a word.
 *
 * So journeys create real objects as real accounts. Which means cleanup is
 * not housekeeping, it is a safety property, and every decision here FAILS
 * CLOSED: four conditions, all required, any doubt → do not delete.
 */

export const SWEEP_OBJECT_RE = /^vs-(\d{13})-([0-9a-z]{6})-([0-9a-z][0-9a-z-]*)$/
export const RUN_ID_RE = /^(\d{13})-([0-9a-z]{6})$/
export const REAP_MAX_AGE_MS = 60 * 60 * 1000

export function randomSuffix(random = Math.random) {
  return Math.floor(random() * 36 ** 6).toString(36).padStart(6, "0").slice(-6)
}

/**
 * The timestamp lives IN THE NAME because these stores cannot tell you an
 * object's age — manifests come back with `mtimeMs: 0`, summaries with
 * `updatedAt: null`. An age you cannot read is an age you must carry.
 */
export function newRunId(nowMs, rand = () => randomSuffix()) {
  return `${String(nowMs).padStart(13, "0")}-${rand()}`
}

export function runScopedName(runId, suffix) {
  if (!RUN_ID_RE.test(runId)) throw new Error(`bad run id: ${runId}`)
  return `vs-${runId}-${suffix}`
}

/**
 * May this object be deleted from production?
 *
 * @param {string} name
 * @param {{now:number, maxAgeMs:number, currentRunId:string}} o
 * @returns {{reap:boolean, why:string}}
 */
export function reapDecision(name, o) {
  const m = SWEEP_OBJECT_RE.exec(String(name ?? ""))
  if (!m) return { reap: false, why: "not shaped like a run-scoped test object" }

  const [, ts, rand] = m
  const runId = `${ts}-${rand}`
  if (runId === o.currentRunId) return { reap: false, why: "belongs to the run in progress" }

  const minted = Number(ts)
  if (!Number.isFinite(minted)) return { reap: false, why: "unreadable timestamp" }
  if (minted > o.now) return { reap: false, why: "timestamp is in the future — clock skew, do not touch" }
  if (o.now - minted < o.maxAgeMs) return { reap: false, why: "too young; another run may still own it" }

  return { reap: true, why: `abandoned ${Math.floor((o.now - minted) / 60000)} min ago by run ${runId}` }
}

/** Undo in the reverse of the order things were created. */
export function cleanupOrder(created) {
  return [...created].reverse()
}

/**
 * Cleanup runs EVEN WHEN THE ASSERTIONS FAILED — otherwise the first red run
 * poisons every run after it. And a cleanup that could not complete is a RED
 * CELL NAMING THE OBJECT, never a silence.
 */
export function journeyVerdict(steps, cleanups) {
  const leftBehind = cleanups.filter((c) => !c.ok)
  if (leftBehind.length > 0) {
    return {
      status: "fail",
      reason: "LEFT BEHIND in production",
      detail: leftBehind.map((c) => `${c.kind}:${c.name} (${c.why ?? "cleanup failed"})`).join(" · "),
    }
  }
  const failed = steps.filter((s) => !s.ok)
  if (failed.length > 0) {
    const first = failed[0]
    return { status: "fail", reason: `${first.name} failed`, detail: first.why ?? "" }
  }
  const skipped = steps.filter((s) => s.skipped)
  if (skipped.length === steps.length && steps.length > 0) {
    return { status: "skip", reason: skipped[0].why ?? "every step skipped" }
  }
  return { status: "pass", reason: `${steps.length} step(s)` }
}
