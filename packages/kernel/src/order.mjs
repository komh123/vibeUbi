/**
 * order.mjs — the step vibeUbi ORDERS and an agent FULFILS.
 *
 * WHY THIS SHAPE, and not "the pipeline drives a browser".
 *
 * `dom-test` is a skill: instructions for an agent, plus probe scripts. Its
 * first rule is that input must be real — CDP, not `dispatchEvent` — because
 * measured on one element, synthetic input fired 3 events with `isTrusted:
 * false` where real input fired 11, all true. Five of the eight types never
 * fired at all, so a click-vs-drag bug lives in a channel the synthetic path
 * cannot reach *even while testing it*.
 *
 * Driving that well needs judgement: which invariants matter for this page,
 * whether a red channel is the app or the fixture, when a locator has gone
 * stale rather than the app being broken. That is agent work, and pretending
 * otherwise produces a worse test.
 *
 * But a gate whose verdict comes from a model is not a gate. So the split is
 * the one this product already runs on:
 *
 *     the agent may WIDEN what gets checked — it may not move the pass mark
 *
 * vibeUbi writes an ORDER: which features, at what priority, and which
 * invariants each must satisfy. The agent runs whatever skill is configured
 * and writes back a RESULT. This module judges the result, mechanically, and
 * the rules below are all about the ways a result can look complete and not be.
 *
 * THE SKILL IS A SLOT. `dom-test` is the default because it is the one whose
 * evidence channels match what the registry knows how to ask for, but nothing
 * here knows what a browser is. A security skill, an a11y skill, a
 * performance skill: same order, same result shape, same judging.
 */

/** Verdicts a skill may report. Names taken from dom-test's own checklist
 *  table, plus `scenario.js`'s fifth state, so a skill that already speaks
 *  that vocabulary needs no translation layer. */
export const SKILL_VERDICTS = Object.freeze([
  "PASS",              // the condition held and no channel went red
  "PASS_WITH_NOISE",   // the condition held WHILE a channel went red
  "FAIL",              // the condition did not hold
  "BLOCKED",           // could not reach the step (needs a role, OAuth, IME…)
  "NOT_EXERCISED",     // reached but not run
])

/**
 * The whole-page relations that need nobody to author them.
 *
 * Every one is from `dom-test/invariants.md`, where each row carries the bug it
 * would have caught. These apply to any page, so a project gets value from this
 * step before it has written a single feature-specific probe — which matters,
 * because a step that is worthless until somebody does a week of authoring is a
 * step nobody turns on.
 */
export const FREE_INVARIANTS = Object.freeze([
  { id: "no-new-errors", why: "the red console flash; a hydration mismatch that repaints the page differently" },
  { id: "no-unprompted-shifts", why: "the page jumping while you read it; a button moving under the cursor" },
  { id: "no-sideways-scroll", why: "爆版 at 390px — a table or composer forcing horizontal scroll" },
  { id: "contrast-both-themes", why: "white-on-white after a theme switch; a border that vanishes" },
  { id: "reload-equals", why: "the rename that showed the new name until F5" },
])

/**
 * What to ask for, derived from the registry rather than from anyone's memory.
 *
 * Ordered by priority because this is the expensive step: if it is cut short,
 * it must be cut short at the least important end, and what was not reached has
 * to be *named* rather than missing.
 */
export function probeOrder({ discovered = [], declared = [], artifactId, base, skill = "dom-test", only = ["P0"] }) {
  const byId = new Map(declared.map((d) => [d.id, d]))
  const items = discovered
    .filter((d) => d.kind === "page")
    .map((d) => {
      const dec = byId.get(d.id) ?? {}
      return {
        id: d.id,
        priority: dec.priority ?? "P2",
        testId: dec.testId ?? null,
        probes: dec.probes ?? [],
        invariants: FREE_INVARIANTS.map((i) => i.id),
      }
    })
    .filter((i) => only.includes(i.priority))
    .sort((a, b) => a.priority.localeCompare(b.priority))

  return { skill, artifactId, base, at: "probe", items }
}

/**
 * May this result be believed at all?
 *
 * A result file is a REPORT, and a report is the class of evidence this whole
 * product refuses. So before any verdict is read: does it belong to THIS
 * deploy? Without that check, yesterday's green file passes today's ship — the
 * same failure as a `/version` endpoint that echoes the git commit instead of
 * the deployed artifact, which is the defect `deployProof` exists for.
 */
export function skillResultAdmission({ order, result }) {
  const faults = []
  if (!result || typeof result !== "object") return { ok: false, reason: "no result was written — the skill did not run, or wrote somewhere else" }
  if (result.skill !== order.skill) {
    faults.push(`the result is from "${result.skill}" and the order was for "${order.skill}" — a swapped skill silently answering a different question`)
  }
  if (!result.artifactId) {
    faults.push("the result does not name an artifact, so nothing ties it to a deploy")
  } else if (result.artifactId !== order.artifactId) {
    faults.push(
      `the result was produced against ${result.artifactId} and this deploy is ${order.artifactId}. ` +
      `A stale green file is how a gate passes on evidence about a build nobody is running.`,
    )
  }
  if (!Array.isArray(result.observed)) faults.push("`observed` is missing or not a list")
  return faults.length === 0 ? { ok: true } : { ok: false, reason: faults.join("; ") }
}

/**
 * Turn a skill's result into cells the gate already knows how to judge.
 *
 * Every rule here exists because of a way a result can look complete and not
 * be — and the first one is the load-bearing one:
 *
 *   ORDERED BUT NOT REPORTED IS NOT A PASS. `dom-test` says this about itself
 *   ("a short green list must never read as full coverage") and it is the same
 *   sentence as this pipeline's own coverage rule. A skill that returns three
 *   green rows for a twelve-item order has told you nothing about nine of them.
 *
 * @param {object} o
 * @param {boolean} [o.noiseIsFailure] dom-test's checklist table says a channel
 *   going red on an item whose condition held "is still a FAIL of that item —
 *   that is precisely what the manual tester would have noticed". Its
 *   `scenario.js` is looser and reports "PASS (with noise)" at the top level.
 *   The two halves of the skill disagree; this follows the stricter one, and
 *   the knob exists so a project can say otherwise ON PURPOSE rather than by
 *   inheriting whichever half it happened to read.
 */
export function orderVerdict({ order, result, noiseIsFailure = true }) {
  const admitted = skillResultAdmission({ order, result })
  if (!admitted.ok) {
    return {
      cells: [{ feature: "probe", layer: "probe", priority: "P0", status: "error", reason: admitted.reason }],
      covered: 0,
      ordered: order.items.length,
    }
  }

  const byId = new Map(result.observed.map((o) => [o.id, o]))
  const cells = []
  for (const item of order.items) {
    const got = byId.get(item.id)
    if (!got) {
      cells.push({
        feature: item.id, layer: "probe", priority: item.priority, status: "error",
        reason: `ordered and not reported. A result that omits an item says nothing about it, and a short green list must never read as full coverage.`,
      })
      continue
    }
    const v = String(got.verdict ?? "").toUpperCase()
    if (!SKILL_VERDICTS.includes(v)) {
      cells.push({
        feature: item.id, layer: "probe", priority: item.priority, status: "error",
        reason: `unrecognised verdict "${got.verdict}". An unknown verdict is not a pass — see what a misspelled severity used to cost.`,
      })
      continue
    }
    const status =
      v === "PASS" ? "pass"
      : v === "PASS_WITH_NOISE" ? (noiseIsFailure ? "fail" : "pass")
      : v === "FAIL" ? "fail"
      : "error"   // BLOCKED and NOT_EXERCISED are both "we do not know"
    cells.push({
      feature: item.id, layer: "probe", priority: item.priority, status,
      reason: got.why ?? v,
      evidence: got.evidence ?? null,
      skillVerdict: v,
    })
  }

  // Anything the skill reported that nobody ordered is kept, not dropped: it is
  // the agent WIDENING the check, which is the half it is allowed to do.
  for (const o of result.observed) {
    if (order.items.some((i) => i.id === o.id)) continue
    cells.push({
      feature: o.id, layer: "probe", priority: "P2", status: String(o.verdict).toUpperCase() === "PASS" ? "pass" : "fail",
      reason: `not ordered — the skill checked this on its own initiative. ${o.why ?? ""}`.trim(),
      skillVerdict: String(o.verdict ?? "").toUpperCase(),
      volunteered: true,
    })
  }

  return {
    cells,
    ordered: order.items.length,
    covered: order.items.filter((i) => byId.has(i.id)).length,
  }
}
