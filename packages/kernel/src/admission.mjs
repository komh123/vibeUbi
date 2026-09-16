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

  /**
   * Some findings are not debt, and accepting them is not a decision a team
   * gets to make.
   *
   * "This check could not run" is the clearest case. Written into a baseline it
   * reads as "we looked at this and accepted it", when the truth is nobody
   * looked — and from then on the gate is off for that check, permanently,
   * because a thing that never runs never produces a NEW finding.
   *
   * Found by a peer session reviewing the withheld-grade change: the grade
   * correctly said "—", and baselining the coverage finding still took the
   * exit code from 1 to 0. Fixing the display is not fixing the gate.
   */
  if (finding.admissible === false) {
    return {
      admit: false,
      reason:
        `"${finding.rule ?? "this finding"}" says a check did not run. That is not debt and cannot be accepted — ` +
        `a baseline entry asserts somebody looked, and the whole content of this finding is that nobody did. ` +
        `Restore the check, or stop requesting it; there is no third option that leaves the gate honest.`,
    }
  }

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

/**
 * Where did this text-scanning rule's match actually land?
 *
 * `checkAssertsOnBehaviour` catches a check that never calls its subject. This
 * catches the sibling: a check that DOES scan source text, and matches things
 * that are not the thing it is looking for.
 *
 * Contributed after the same shape bit three times in one day — a gate
 * comparing a script's source, a regex that matched its OWN comment, and a
 * regex that matched a function's parameter types. Measured elsewhere: a
 * hand-written dead-code scanner produced 137 false positives out of 177.
 *
 * WHY THIS ONE MATTERS MORE THAN IT LOOKS. A text rule with no lexical
 * awareness does not merely waste time — it manufactures exactly the pressure
 * `baselineAdmission` exists to refuse. Enough false positives and the obvious
 * remedy becomes "baseline them", and now the record formally asserts that a
 * pile of non-problems are real accepted debt.
 *
 * The fix for a match outside executable code is always a lexer, never an
 * allow-list: an allow-list grows one entry per false positive forever and
 * silently suppresses the true positive that happens to share a line.
 */
export const NON_CODE_REGIONS = Object.freeze(["comment", "string-literal", "type-annotation", "own-source", "test-fixture", "generated"])

/**
 * @param {{pattern?:string, matchedIn:string, sample?:string}} hit
 *   `matchedIn` — where the match landed once the source is actually lexed.
 */
export function sourceScanHit(hit) {
  const where = String(hit.matchedIn ?? "")
  if (!NON_CODE_REGIONS.includes(where)) return { real: true, where }

  const why = {
    "comment": "matched prose, not code — the rule is reading the explanation of the thing instead of the thing",
    "string-literal": "matched inside a string; the text exists, the behaviour does not",
    "type-annotation": "matched a type, which is erased before anything runs",
    "own-source": "the rule matched ITSELF — its own pattern or the line documenting it",
    "test-fixture": "matched a deliberate example planted to prove the rule works",
    "generated": "matched generated output nobody edits",
  }[where]

  return {
    real: false,
    where,
    reason:
      `${why}. This is a FALSE POSITIVE, so it must be fixed with a lexer — never with an allow-list ` +
      `(one entry per false positive, forever, and it silently suppresses the true positive that shares a line) ` +
      `and never by baselining it (see baselineAdmission: a baseline entry is a signature saying the finding is real).`,
  }
}

/**
 * Is a text-scanning rule fit to gate on at all?
 *
 * A rule whose matches are mostly not real does not become trustworthy by
 * having its output accepted; it becomes trustworthy by being rewritten.
 */
export function textRuleFitness({ hits, name = "rule" }) {
  const judged = hits.filter((h) => h.matchedIn)
  if (judged.length === 0) return { ok: true, precision: 1, reason: "nothing to judge" }
  const real = judged.filter((h) => sourceScanHit(h).real).length
  const precision = real / judged.length
  if (precision >= 0.9) return { ok: true, precision, reason: `${real}/${judged.length} real` }
  return {
    ok: false,
    precision,
    reason:
      `${name} matched ${judged.length} times and only ${real} were real (${Math.round(precision * 100)}%). ` +
      `A rule at this precision cannot gate: people will stop reading it, and the pressure to absorb its noise ` +
      `into the baseline is how non-problems get signed for as real debt. Give it a lexer before it gates anything.`,
  }
}

/**
 * Is every field the registry declares actually READ by something?
 *
 * The defect this project is named after, turned on the project itself: the
 * gate's cell builder derived every priority from a finding's severity and
 * never looked at the `priority` the registry declared. `adopt` had marked 34
 * routes P0; the gate saw 34 P1s and shipped over them.
 *
 * A declared field nobody consumes is worse than a missing one. A missing
 * field is an error somebody fixes. A field that is written, reviewed, and
 * ignored looks like a control and is a decoration — and everyone downstream
 * believes it is doing something.
 *
 * @param {readonly object[]} declared   the registry entries
 * @param {readonly string[]} readFields fields the pipeline actually consumes
 */
/**
 * The declared fields this pipeline actually consumes, and WHERE.
 *
 * This list is the one thing `declaredFieldsAreRead` compares against, so it
 * has to be honest rather than aspirational — a field listed here that nothing
 * reads turns the check into the decoration it exists to detect. Each entry
 * therefore names its consumer, and `declaredFieldListIsHonest` in the tests
 * goes red if a consumer disappears.
 */
export const READ_DECLARED_FIELDS = Object.freeze({
  id: "everywhere — it is the join key",
  kind: "sweep generator, discoverers, adopt",
  priority: "the gate: which findings are P0 and therefore block",
  requiredRole: "S2.route.ungated: `guest` means a human declared this public",
  source: "findings point at the file",
  area: "the architecture view and adopt's summary",
})

export function declaredFieldsAreRead(declared, readFields) {
  const present = new Set()
  for (const d of declared) for (const k of Object.keys(d)) present.add(k)
  const read = new Set(readFields)
  const unread = [...present].filter((k) => !read.has(k) && !k.startsWith("_"))
  if (unread.length === 0) return { ok: true }
  return {
    ok: false,
    unread,
    reason:
      `these declared field(s) are read by nothing: ${unread.join(", ")}. ` +
      `A field that is written, reviewed and then ignored looks like a control and is a decoration — ` +
      `and everyone downstream believes it is doing something.`,
  }
}
