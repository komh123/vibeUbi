/**
 * admission.mjs — what may enter a baseline, and how wide an exemption may be.
 *
 * Both rules here came from the session that runs this pipeline every day, and
 * both are about the SAME asymmetry:
 *
 *     In a gate, a false positive is more dangerous than a false negative,
 *     because the natural remedy for a false positive is to write it down.
 *
 * A false negative is a hole. A false positive becomes a BASELINE ENTRY — and
 * a baseline entry is a signed statement that the finding is real and the team
 * accepted it. So a reporting bug gets laundered into a standing lie that
 * outlives everyone who knew better.
 *
 * The observed case: a coverage checker did not recognise a third way of
 * invoking tests, so it reported two test files that were *actually running*
 * as "nobody runs these". The obvious fix was to add them to the baseline —
 * which would have formally declared that nobody runs them.
 */

/**
 * May this finding be written into the baseline?
 *
 * @param {{fingerprint:string, severity:string, verdict?:string, reason?:string}} finding
 *   `verdict` is the human's assessment: "real" (accepted debt),
 *   "false-positive" (the rule is wrong), or "correct-behaviour" (the system is
 *   right and the rule disagrees).
 */
export function baselineAdmission(finding) {
  const verdict = finding.verdict ?? "real"

  if (verdict === "false-positive" || verdict === "correct-behaviour") {
    return {
      admit: false,
      reason:
        `this was judged "${verdict}", so it must be fixed in the RULE, not absorbed into the baseline. ` +
        `A baseline entry is a signed statement that the finding is real and was accepted — ` +
        `writing a reporting bug in there turns it into a standing lie, and the next person ` +
        `has no way to tell it apart from real debt.`,
    }
  }

  if (!String(finding.reason ?? "").trim()) {
    return {
      admit: false,
      reason: "accepting debt without a written reason is how nobody can tell, a year later, whether it was a decision or an accident",
    }
  }

  return { admit: true }
}

/**
 * How wide may an exemption be?
 *
 * The observed case: a layer went red three ships running on a `404` that was
 * the CORRECT answer — a file the user had legitimately not created. The first
 * two retries "passed" and were filed as flake; the third rolled back a
 * perfectly good build.
 *
 * The fix was right and the SHAPE of the fix is what matters: name that one
 * file. Not the endpoint, not the layer, not the feature. A gate that goes red
 * on correct behaviour must be narrowed to exactly the correct behaviour —
 * anything wider silently turns off the real checks that share the surface.
 */
export function exemptionScope(exemption) {
  const target = String(exemption.target ?? "")
  const faults = []

  if (!target) faults.push("an exemption with no target exempts everything")
  if (/[*?]|^\/?$/.test(target)) {
    faults.push(`"${target}" is a wildcard — it turns off every real check that shares this surface, not just the one correct behaviour`)
  }
  if (!String(exemption.reason ?? "").trim()) {
    faults.push("no reason given; in six months the record must say WHY nobody looked, not merely that nobody did")
  }
  if (!exemption.observed) {
    faults.push("no record of the behaviour being exempted — without it nobody can later check whether it is still correct")
  }

  return faults.length === 0
    ? { ok: true }
    : { ok: false, reason: faults.join(" · ") }
}

/**
 * A check that asserts on how a file LOOKS rather than what it DOES.
 *
 * The observed case: three gate assertions compared the source text of a
 * script. Upstream shrank that script from 187 lines to 29 and moved the
 * capability elsewhere — so the gate went red on SPELLING while the behaviour
 * was fine, and the fix was to make the checks call the thing instead.
 *
 * A check like this fails for the wrong reason during a refactor and, worse,
 * passes for the wrong reason when the text survives but the behaviour does
 * not. Same family as everything else in this kernel: measure the outcome, not
 * the report of it.
 */
export function checkAssertsOnBehaviour({ reads, calls }) {
  if (calls) return { ok: true }
  return {
    ok: false,
    reason:
      `this check reads ${reads ?? "source text"} without ever invoking the thing it is checking. ` +
      `It will go red on a rename and green on a gutted implementation — ` +
      `make the subject injectable and call it.`,
  }
}
