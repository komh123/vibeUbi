/**
 * verdict.mjs — ship, or roll back?
 *
 * Zero I/O. Every decision in this file is a pure function over cells, because
 * a gate you cannot unit-test is a gate nobody believes six weeks later.
 */

/** @typedef {{status:string, priority?:string, feature?:string, layer?:string, reason?:string}} Cell */
/** @typedef {{ship:boolean, reason:string, blocking:Cell[]}} Verdict */

/**
 * P0 failures block. So does an `error` cell at ANY priority: a layer that
 * threw did not answer the question, and an unanswered question about the
 * thing we just deployed is not a pass.
 *
 * P1/P2 failures are reported and shipped — the alternative is a pipeline
 * nobody can get through, which ends with people running the build by hand.
 *
 * `blocked` NEVER gates (rolling back cannot reach a dependency that is down)
 * but is ALWAYS said. A gate that ships in silence over an outage teaches
 * people the layer is decorative.
 *
 * @param {readonly Cell[]} cells
 * @returns {Verdict}
 */
export function verdictFor(cells) {
  const blocking = cells.filter(
    (c) => (c.status === "fail" && c.priority === "P0") || c.status === "error",
  )
  const blocked = cells.filter((c) => c.status === "blocked")
  const blockedNote = blocked.length
    ? `${blocked.length} BLOCKED (a dependency is unavailable — not caused by this deploy, and rollback cannot fix it)`
    : ""

  if (blocking.length === 0) {
    const soft = cells.filter((c) => c.status === "fail").length
    const bits = [
      soft > 0 ? `${soft} non-P0 failure(s), reported not blocking` : "",
      blockedNote,
    ].filter(Boolean)
    return { ship: true, reason: bits.join(" · ") || "no failures", blocking: [] }
  }

  const p0 = blocking.filter((c) => c.status === "fail").length
  const errored = blocking.filter((c) => c.status === "error").length
  const bits = [
    p0 > 0 ? `${p0} P0 failure(s)` : "",
    errored > 0 ? `${errored} layer(s) errored` : "",
    blockedNote,
  ].filter(Boolean)
  return { ship: false, reason: bits.join(" and "), blocking }
}

/**
 * Judge on what is known so far — and only ever STOP on it.
 *
 * The gate swaps before it sweeps, because the sweep runs against the live
 * site. That window is the pipeline's worst property, so the cells that CAN
 * block run first and are offered here.
 *
 * WHY AN EARLY STOP CAN NEVER BE WRONG: `verdictFor` refuses on the PRESENCE
 * of a blocking cell, so adding cells can only ADD blockers. What the first
 * phase saw is a subset of what the gate finally sees, so a refusal on the
 * subset is a refusal on the whole — same decision, minutes earlier.
 *
 * `stop: false` does NOT mean "ship". It means "nothing blocking seen YET".
 * The deploy is still cleared by the ordinary gate over ALL cells at the end.
 *
 * @param {readonly Cell[]} known
 */
export function earlyVerdict(known) {
  const verdict = verdictFor(known)
  return { stop: !verdict.ship, verdict }
}

/**
 * Fold everything the run produced into the cells the gate will judge.
 *
 * A layer that could not run at all becomes an `error` cell rather than
 * vanishing — the most dangerous outcome for a gate is a question that was
 * silently not asked.
 *
 * @param {{cells?: readonly Cell[], layerErrors?: readonly {layer:string, why:string}[], degraded?: readonly string[]}} input
 * @returns {Cell[]}
 */
export function gateCells(input) {
  const cells = [...(input.cells ?? [])]
  for (const e of input.layerErrors ?? []) {
    cells.push({
      status: "error",
      priority: "P0",
      layer: e.layer,
      feature: `layer:${e.layer}`,
      reason: e.why,
    })
  }
  // A degraded layer is NOT an error: somebody chose it and wrote down why.
  // It still appears, as a skip that names its excuse, so the record shows
  // what nobody looked at.
  for (const layer of input.degraded ?? []) {
    cells.push({
      status: "skip",
      layer,
      feature: `layer:${layer}`,
      reason: "degraded by explicit choice — see the run's recorded reason",
    })
  }
  return cells
}
