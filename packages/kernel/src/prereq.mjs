/**
 * prereq.mjs — can every layer this run intends to use actually run?
 *
 * Asked BEFORE anything mutates, because of what happens otherwise: a browser
 * layer with no browser answers `error`; the gate treats an error as blocking
 * — correctly — so a missing binary would ROLL BACK A PERFECTLY GOOD DEPLOY.
 * The pipeline would have manufactured an incident out of a tooling gap,
 * after changing production twice.
 *
 * Discovering that at gate time is too late by definition. Discovering it at
 * step one costs nothing.
 *
 * A layer that cannot run is a HARD STOP, not a silent skip: reduced coverage
 * has to be something a person chose, and the choice has to carry a reason
 * that outlives them.
 */

/**
 * @param {readonly string[]} wanted
 * @param {readonly {layer:string, ok:boolean, why?:string}[]} checks
 * @param {readonly {layer:string, reason:string}[]} allowDegraded
 */
export function prereqVerdict(wanted, checks, allowDegraded = []) {
  const excused = new Map(allowDegraded.map((d) => [d.layer, d.reason]))
  const failed = checks.filter((c) => !c.ok && wanted.includes(c.layer))

  const unexcused = failed.filter((c) => !excused.has(c.layer))
  const unreasoned = failed.filter((c) => excused.has(c.layer) && !String(excused.get(c.layer) ?? "").trim())

  if (unexcused.length > 0) {
    return {
      proceed: false,
      reason: unexcused.map((c) => `${c.layer} cannot run (${c.why ?? "unavailable"})`).join("; "),
      missing: unexcused.map((c) => c.layer),
    }
  }
  if (unreasoned.length > 0) {
    return {
      proceed: false,
      reason:
        `${unreasoned.map((c) => c.layer).join(", ")} was waived without a reason. ` +
        `Skipping a layer is a decision, and in six months the record has to say why nobody looked — ` +
        `not merely that nobody did.`,
      missing: unreasoned.map((c) => c.layer),
    }
  }

  const degraded = failed.map((c) => ({ layer: c.layer, reason: excused.get(c.layer) }))
  return {
    proceed: true,
    layers: wanted.filter((l) => !failed.some((f) => f.layer === l)),
    degraded,
  }
}
