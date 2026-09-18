/**
 * symptoms.mjs — from what you can SEE to the rule that catches it.
 *
 * THE PROBLEM THIS SOLVES, reported by a consumer rather than guessed at:
 *
 *   A peer had depended on this kernel for a week and hand-found seven
 *   instances of "declared but never read" — while `declaredFieldsAreRead` sat
 *   in their `node_modules`. The same day, their /tmp cleanup scanner derived
 *   zero prefixes and reported "cleaned 0" as success, which is precisely
 *   `vacuousComparison`. Both rules were already installed.
 *
 * That is not their failure. 85 exports behind one flat index is not a
 * discovery mechanism, and "read all of them" is not one either. **You cannot
 * import what you cannot find.**
 *
 * THE KEY IS THE SYMPTOM, NOT THE NAME. Their words, and they are the design:
 *
 *   "I do not know I have a `vacuousComparison` until after I have found it. I
 *    know that 'my scanner reported 0 and I believed it', 'the gate is green on
 *    a machine where the feature does not exist', 'two lists agree and both are
 *    empty'. Those are the strings I would search."
 *
 * So every entry below leads with what a person actually observes, and the rule
 * name comes last. Each `seen` line is a real sentence somebody said or wrote
 * while hitting that defect — none are invented, because a symptom nobody has
 * ever uttered is not a search term.
 */

/** @typedef {{rule:string, seen:string[], why:string, use:string}} Symptom */

/** @type {readonly Symptom[]} */
export const SYMPTOMS = Object.freeze([
  {
    rule: "testRanVerdict",
    seen: [
      "the suite is green but I do not think it ran anything",
      "exit 0 with # pass 0",
      "the tests passed on a machine where the executable does not exist",
      "it stopped at file 44 of 504 and everything before it was green",
      "I reported the step green and its own output had errors in it",
      "the echo ran whether the command succeeded or not",
    ],
    why: "no bad news was taken for good news",
    use: "testRanVerdict(step, output) — needs the runner's own summary line, N > 0",
  },
  {
    rule: "coveredVerdict",
    seen: [
      "the type check is green and I am not sure it looked at that folder",
      "a config excluded part of the tree and nothing said so",
      "the linter found no problems in a directory it was never pointed at",
      "four months without a type check, exiting 0 every time",
    ],
    why: "a checker over an empty file set exits 0 exactly like one that found nothing",
    use: "coveredVerdict({step, read, expected}) — `read` from the tool itself (tsc --listFiles), never from your own list",
  },
  {
    rule: "vacuousComparison",
    seen: [
      "my scanner reported 0 and I believed it",
      "it derived zero patterns and said cleaned 0 as if that were success",
      "the check passed because there was nothing to check",
      "the comparison could not have failed",
    ],
    why: "a check whose inputs make failure impossible is not a check",
    use: "vacuousComparison(...) — and see `sameObserved` when two sources are compared",
  },
  {
    rule: "sameObserved",
    seen: [
      "two lists agree and both are empty",
      "both sides returned an empty string so they matched",
      "neither side could read the value and the comparison said equal",
      "the version endpoint answered unknown and the check went green",
    ],
    why: "unreadable must have a representation that is not equal to any real value; two absences are not a match",
    use: "sameObserved(a, b) — three answers: same, different, and we do not know",
  },
  {
    rule: "declaredFieldsAreRead",
    seen: [
      "the field is written, reviewed, and nothing reads it",
      "a config knob with zero call sites",
      "we set that flag and it changed nothing",
      "the type declares it and no consumer exists",
    ],
    why: "a field that is written and ignored looks like a control and is a decoration",
    use: "declaredFieldsAreRead(declared, readFields) — keep the read-fields list honest, with a test per consumer",
  },
  {
    rule: "runtimeFloorVerdict",
    seen: [
      "I ran it with node 22 but the step got node 18",
      "engines says 22 and the child process is on 18",
      "`type -P node` points at a wrapper that ignores nvm",
      "the parent version changed and the thing under test did not",
    ],
    why: "engines is read by npm at install time and by nothing at run time",
    use: "runtimeFloorVerdict({running, floor}) — and spawn process.execPath, never the string \"node\"",
  },
  {
    rule: "crossLayerNames",
    seen: [
      "each side is correct on its own and only the pair is wrong",
      "the name exists in the service and not in the protocol",
      "frames are dropped silently and the symptom is a timeout far away",
      "no test on either side could have failed",
    ],
    why: "two lists that must agree, where neither is the authority",
    use: "crossLayerNames({a, b, symptom}) — carry the observable symptom so it is findable from that end",
  },
  {
    rule: "proofDiscrimination",
    seen: [
      "the version endpoint returns the same thing for every build",
      "commit is null on every deploy",
      "it changes every deploy but a rollback gives it a new value too",
      "the proof cannot tell which build is running",
    ],
    why: "a proof's SHAPE can satisfy the contract while identifying nothing",
    use: "proofDiscrimination(samples) — two directions: it must change on a swap AND return on a rollback",
  },
  {
    rule: "deployProof",
    seen: [
      "the deploy script exited 0 and the old build is still serving",
      "restart returned success and the swap did not take",
      "the health check is 200 and the page is the previous version",
    ],
    why: "evidence from inside the thing being deployed is not evidence",
    use: "deployProof({expected, previous, observed}) — observed must come from OUTSIDE the process",
  },
  {
    rule: "orphanVerdict",
    seen: [
      "a feature exists and nobody declared it",
      "the registry lists something that is not there any more",
      "we added the tool and never registered it",
    ],
    why: "discovered-but-undeclared and declared-but-undiscovered are both defects, in opposite directions",
    use: "orphanVerdict(discovered, declared, ignored)",
  },
  {
    rule: "baselineAdmission",
    seen: [
      "we added the false positive to the baseline",
      "the accepted-debt entry has no reason",
      "nobody can tell whether that was a decision or an accident",
    ],
    why: "a baseline entry is a signed statement that the finding is real; a reporting bug written there becomes a standing lie",
    use: "baselineAdmission(finding) — refuses `false-positive` and `correct-behaviour` outright",
  },
  {
    rule: "manualGapVerdict",
    seen: [
      "the only fix is on the host and a person has to do it",
      "it went into a runbook and nobody knows if it was done",
      "a guard that has never run",
      "we could not look, and the report said it was fine",
    ],
    why: "a fix only a human can perform still has an observable state",
    use: "manualGapVerdict({gap, observed, at}) — the gap must carry a probe and a vantage, or it is refused",
  },
  {
    rule: "observationAge",
    seen: [
      "we have a guard, but did it run this month",
      "every run reported not-here, legitimately, forever",
      "the probe is wired and has never been reached",
    ],
    why: "a vantage makes silence legitimate, and legitimate silence is still silence",
    use: "observationAge({lastObservedAt, lastAttemptedAt}) — never-wired and never-reached need different fixes",
  },
  {
    rule: "atOrAbove / weightOf",
    seen: [
      "a finding with a misspelled severity cost nothing and did not block",
      "the severity was SEV-1 and the scorer had never heard of it",
    ],
    why: "an unrecognised severity is the quietest possible way to turn off a gate",
    use: "weightOf(severity) — unknown weighs as `high`, never as zero",
  },
  {
    rule: "coverageOf / grade",
    seen: [
      "the scan found nothing because it scanned nothing",
      "an unrecognised stack came back grade A",
      "a requested layer did not run and the report was clean",
    ],
    why: "a grade is a claim about coverage, so it cannot be issued without any",
    use: "grade(findings, unmeasured) — the letter is withheld, not lowered",
  },
  {
    rule: "remediationVerdict",
    seen: [
      "the error message tells the user to do something that can never help",
      "we told them to update and updating cannot fix that cause",
      "two different causes produced the same instruction",
      "the field that separates the two cases was in the payload and nobody read it",
    ],
    why: "a remediation is a claim that doing this will change your situation, and it can be false",
    use: "remediationVerdict({cause, remediation, resolves}) — declare what each action can actually clear",
  },
  {
    rule: "implementationsAgree",
    seen: [
      "one rule, two implementations, I changed one of them",
      "there is a gate copy and a report copy of the same rule",
      "one call site honours it and another does not",
      "each copy is correct on its own and passes its own tests",
    ],
    why: "copies that were never meant to exist are not declared a pair, so nothing compares them",
    use: "implementationsAgree({rule, implementations, cases}) — run every copy over the same inputs",
  },
  {
    rule: "countIsNotFitness",
    seen: [
      "the count went up and the content is irrelevant",
      "156 services listed, 0 connected",
      "I concluded the backend worked from the number of results",
      "the results came back and none of them were what I asked for",
    ],
    why: "how many came back and are any of them right are different measurements that arrive together",
    use: "countIsNotFitness({counted, checked, fit}) — nothing examined the items",
  },
  {
    rule: "populationVerdict",
    seen: [
      "the number is for a population I never measured",
      "the percentage is right and it describes a different group",
      "I used a recent sample to make a claim about what reached production",
      "the denominator is not written down anywhere near the figure",
    ],
    why: "the arithmetic is fine and the population is wrong, which no recomputation reveals",
    use: "populationVerdict({claimAbout, measured, n})",
  },
  {
    rule: "hangVerdict",
    seen: [
      "the timeout message told me to look for a network call and there was none",
      "load average was low so it said the machine was not busy",
      "it was not hung, it was thrashing against swap",
      "the diagnosis was confident and every clause of it was wrong",
    ],
    why: "load average cannot tell a thrashing process from a hung one — both sit at the same number",
    use: "hangVerdict({rssGb, swapUsedGb, swapUsedGbAtStart, ceilingGb}) — with no swap reading it returns `unknown` and offers no theory",
  },
  {
    rule: "attributedVerdict",
    seen: [
      "the gate said it ruled out a pre-existing cause and it never looked at the old build",
      "the re-check runs on the same build, so it cannot say whose fault it is",
      "a failure that was already there blocks every deploy for ever",
      "it passed the second time so we called the deploy innocent",
    ],
    why: "a claim of attribution needs both sides of the change; one side reports consistency only",
    use: "attributedVerdict(first, retry, {onPrevious}) — three answers: consistent, intermittent, pre-existing",
  },
  {
    rule: "VANTAGE_ANY / observableFrom",
    seen: [
      "the probe works everywhere and there is no way to say so",
      "the guard reports not-here on every run, legitimately, for ever",
      "the probe produced a real observation and the verdict threw it away",
    ],
    why: "a vantage that cannot express `anywhere` turns a working probe into a permanently silent one",
    use: 'declare vantage: "any" — a sentinel the kernel knows, not a looser string comparison',
  },
  {
    rule: "mitigationStillPays",
    seen: [
      "the warm start is now slower than the cold one",
      "the cache it copies was 2 GB when this was written and is 14 GB now",
      "a workaround that was correct became the heavier path",
    ],
    why: "a mitigation guarded by `does it exist` never re-checks the premise it was chosen on",
    use: "mitigationStillPays({mitigated, plain, ceiling}) — compare the costs, not the presence",
  },
])

/**
 * Find the rules whose symptoms match what you can see.
 *
 * Deliberately a plain substring-and-token search rather than anything clever:
 * the entries are written in the words people actually use, so the matching
 * does not need to be smart — and a fuzzy matcher that returns something for
 * every query is worse than one that honestly returns nothing.
 */
const STOPWORDS = new Set([
  // Words that appear in almost every entry, so matching on them ranks by
  // English rather than by meaning. The first version scored a hit on "and" and
  // put an unrelated rule third.
  "and", "the", "that", "this", "with", "for", "was", "were", "not", "but", "its",
  "are", "is", "it", "a", "an", "of", "to", "in", "on", "my", "i", "we", "you",
  "have", "has", "had", "did", "does", "do", "so", "then", "than", "which",
])

export function findRule(query, symptoms = SYMPTOMS) {
  const q = String(query ?? "").toLowerCase().trim()
  if (!q) return []
  const words = q.split(/\W+/).filter((w) => w.length > 2 && !STOPWORDS.has(w))

  const scored = symptoms.map((s) => {
    const seenText = s.seen.join(" \n ").toLowerCase()
    const matched = s.seen.filter(
      (line) => line.toLowerCase().includes(q) || words.some((w) => line.toLowerCase().includes(w)),
    )

    const hitWords = words.filter((w) => seenText.includes(w))
    // How much of what they TYPED this entry accounts for. A ten-word symptom
    // that overlaps on one common noun is not a match, however high its raw
    // score — and raw scores alone were returning `orphanVerdict` for "the
    // error message tells the user to do something that can never help" on the
    // strength of "something" and "never".
    const coverage = words.length ? hitWords.length / words.length : 0

    let score = 0
    if (seenText.includes(q)) score += 100
    score += hitWords.length * 4
    for (const w of words) if (s.why.toLowerCase().includes(w)) score += 1
    if (s.rule.toLowerCase().includes(q)) score += 5

    return { ...s, score, matched, coverage, hitWords: hitWords.length }
  })

  // The bar: an exact phrase, or enough of the query accounted for that the
  // entry is plausibly about the same thing. A peer put it best about their own
  // tooling — the failure was never "no diagnosis", it was A CONFIDENT WRONG
  // ONE, which is strictly worse than silence because it sends you to spend an
  // hour on the wrong theory. That applies to this function before anything else.
  const hits = scored.filter(
    (s) => s.seen.join(" ").toLowerCase().includes(q) || (s.hitWords >= 2 && s.coverage >= 0.4),
  )
  return hits.sort((a, b) => b.score - a.score || a.rule.localeCompare(b.rule))
}

/**
 * Has a mitigation stopped paying for itself?
 *
 * A peer's warm-start copied a build cache into a scratch directory, guarded
 * only by "does the cache exist". Its own comment recorded that cache as 2.1 GB.
 * Measured the day this was written: **14 GB** — 313 seconds to copy, a build
 * peaking at 16.7 GB RSS against a 21 GB ceiling, and no finish in 40 minutes.
 * The cold build it was avoiding now fits and the warm one does not.
 *
 * The mitigation was correct when it was written. The thing it measures grew,
 * and nothing re-checked the premise — because the guard asked whether the
 * cache was PRESENT, never whether it was still cheaper.
 *
 * @param {object} o  same unit throughout — MB, seconds, whatever is scarce
 * @param {number} o.mitigated  cost of the path with the mitigation
 * @param {number} o.plain      cost of the path without it
 * @param {number} [o.ceiling]  the wall neither may cross
 */
export function mitigationStillPays({ mitigated, plain, ceiling = Infinity, what = "this mitigation" }) {
  const bad = (v) => !Number.isFinite(v) || v < 0
  if (bad(mitigated) || bad(plain)) {
    return {
      ok: false, known: false,
      reason: `${what}: one of the two costs could not be measured, so nothing is known about which path is cheaper. An unmeasured comparison is not a satisfied one.`,
    }
  }
  if (mitigated > ceiling && plain <= ceiling) {
    return {
      ok: false, known: true, mitigated, plain, ceiling,
      reason:
        `${what} now costs ${mitigated} against a ceiling of ${ceiling}, while the path it avoids costs ${plain} and fits. ` +
        `It was chosen when the numbers were the other way round; the premise was never re-checked because the guard asks whether it EXISTS, not whether it still pays.`,
    }
  }
  if (mitigated >= plain) {
    return {
      ok: false, known: true, mitigated, plain, ceiling,
      reason: `${what} costs ${mitigated} and the path it avoids costs ${plain}. It is no longer the cheaper path.`,
    }
  }
  return { ok: true, known: true, mitigated, plain, ceiling, reason: `${what}: ${mitigated} vs ${plain} — still the cheaper path` }
}
