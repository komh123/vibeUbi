/**
 * acceptance.mjs (ship) — the I/O half of the acceptance step.
 *
 * Every DECISION is in the kernel (`acceptanceContract`, `preSwapBehaviourVerdict`,
 * `acceptanceVerdict`, `retryItems`, `foldAttempts`, then `verdictFor`). This file
 * only calls the fulfiller, bounds how long it may take, and looks at the base —
 * the three things a pure function cannot do.
 */
import {
  acceptanceVerdict, retryItems, foldAttempts, verdictFor, gateCells,
} from "../../kernel/src/index.mjs"

/**
 * Where is acceptance declared? On the config (the project's word) or on the
 * target (an adapter shipping it). Both is refused: two declarations and no
 * rule for which is the gate is how one of them ends up decorative.
 */
export function resolveAcceptance({ config, target }) {
  const c = config?.acceptance ?? null
  const t = target?.acceptance ?? null
  if (c && t) {
    return { decl: null, source: null, error: "acceptance is declared on BOTH the config and the target adapter — two gates, and nothing says which one is the gate. Declare it once." }
  }
  return { decl: c ?? t, source: c ? "config" : t ? "target" : null, error: null }
}

/**
 * Ask the fulfiller once, bounded.
 *
 * It is handed an AbortSignal and ALSO raced against the clock, because a
 * fulfiller that ignores the signal must still not be able to hold the ship —
 * and one that honours it gets to clean up (close a browser) rather than leak it.
 *
 * @returns {Promise<{result: unknown, failure: string|null}>}
 */
export async function fulfilOnce({ decl, order, timeoutMs, attempt = 1 }) {
  const ctrl = new AbortController()
  let timer
  const clock = new Promise((resolve) => {
    timer = setTimeout(() => { ctrl.abort(); resolve({ timedOut: true }) }, timeoutMs)
  })
  const work = Promise.resolve()
    .then(() => decl.fulfil(order, { signal: ctrl.signal, attempt }))
    .then((result) => ({ result }), (err) => ({ threw: err }))
  try {
    const got = await Promise.race([work, clock])
    if (got.timedOut) return { result: null, failure: `the fulfiller exceeded its time budget of ${timeoutMs} ms and was stopped` }
    if (got.threw) return { result: null, failure: `the fulfiller threw: ${got.threw?.message ?? String(got.threw)}` }
    return { result: got.result, failure: null }
  } finally { clearTimeout(timer) }
}

/**
 * ONE look at the base, trusting nobody — the same one the probe takes.
 *
 * After the swap `withArtifact` also asks the adapter which artifact is serving
 * NOW, so a result that is true of a build that has since been replaced is
 * caught. Before the swap there is no artifact of ours to compare, so the
 * caller passes false and gets liveness alone — and `null` (not a made-up
 * "alive") when the base cannot be reached, because the judge names "no look
 * was taken" and an invented one would be the thing it exists to prevent.
 */
export async function observeBase({ target, base, artifactId, previousId, withArtifact }) {
  const liveness = await fetch(base, { redirect: "manual" })
    .then((r) => ({ ok: r.status < 500, status: r.status }))
    .catch((e) => ({ ok: false, unreachable: e.cause?.code ?? e.message }))
  if (liveness.ok && withArtifact) {
    try {
      const seen = await target.proof({ base, expected: artifactId, previous: previousId })
      if (typeof seen?.observed === "string" && seen.observed.includes(artifactId)) liveness.artifact = artifactId
      else if (typeof seen?.observed === "string" && seen.observed.trim()) liveness.artifact = seen.observed.trim().slice(0, 120)
    } catch { /* the adapter could not look; the null case is already named */ }
  }
  return liveness
}

/**
 * Fulfil, judge, and — for a P0 that FAILED and has attempts left — ask again.
 *
 * Retries re-ask only about the failed items and are folded back by the kernel,
 * so a pass-on-retry arrives as `flaky`, with the failure it overwrote in its
 * reason. Nothing here decides what a failure is.
 *
 * @returns {Promise<{cells: object[], flaky: object[], rounds: number}>}
 */
export async function judgeRounds({ decl, order, phase, timeoutMs, look, say = () => {} }) {
  const rounds = []
  let current = order
  for (let attempt = 1; ; attempt++) {
    const { result, failure } = await fulfilOnce({ decl, order: current, timeoutMs, attempt })
    let cells
    if (failure) {
      // Not "no result was written": that sends the operator to a file that was
      // never going to exist. The fulfiller itself failed, and says how.
      cells = [{ feature: "acceptance", layer: "acceptance", priority: "P0", status: "error", reason: failure }]
    } else {
      cells = acceptanceVerdict({
        order: current, result, liveness: await look(), phase, noiseIsFailure: decl.noiseIsFailure ?? true,
      }).cells
    }
    rounds.push(cells)
    const again = failure ? [] : retryItems({ order, cells, attemptsDone: attempt })
    if (again.length === 0) break
    say("warn", `acceptance: ${again.join(", ")} failed attempt ${attempt} — trying again before declaring a failure`)
    current = { ...order, items: order.items.filter((i) => again.includes(i.id)) }
  }
  return { ...foldAttempts(rounds), rounds: rounds.length }
}

/**
 * What the report and the operator are told, derived from the final cells.
 *
 * `failed` are the cells the verdict BLOCKS on — the ones that rolled back (or
 * refused). `warnings` are failures that did not gate. Both name the item,
 * because a count is not a diagnosis.
 */
export function acceptanceSummary({ decl, source, order, cells, flaky, rounds, warning = null }) {
  const verdict = verdictFor(gateCells({ cells, degraded: [] }))
  const blocking = new Set(verdict.blocking)
  const slim = (c) => ({ id: c.feature, severity: c.priority, status: c.status, reason: c.reason, ...(c.attempts ? { attempts: c.attempts } : {}) })
  const byId = new Map(cells.map((c) => [c.feature, c]))
  const statusOf = (id) => byId.get(id)?.status ?? "missing"
  const ids = order.items.map((i) => i.id)
  const verified = ids.filter((id) => statusOf(id) === "pass").length
  const failedItems = ids.filter((id) => statusOf(id) === "fail").length
  return {
    verdict,
    summary: {
      phase: decl.phase, declaredOn: source,
      ordered: ids.length, verified, unverified: ids.length - verified - failedItems, rounds,
      failed: cells.filter((c) => blocking.has(c)).map(slim),
      warnings: cells.filter((c) => c.status === "fail" && !blocking.has(c) && !c.volunteered).map(slim),
      flaky,
      ...(warning ? { stagingWarning: warning } : {}),
    },
  }
}
