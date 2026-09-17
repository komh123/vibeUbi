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

import { sameObserved } from "./proof.mjs"

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
  const decById = new Map(declared.map((d) => [d.id, d]))
  const seen = new Set(discovered.filter((d) => d.kind === "page").map((d) => d.id))

  /**
   * The universe is discovered ∪ declared, not discovered alone.
   *
   * The first version built `items` from `discovered` and used `declared` only
   * as a lookup for extra fields — so a declared P0 that discovery MISSED was
   * silently absent from the order. A peer proved it with a falsifiable pair:
   * same declaration, one run with the page discovered (1 item) and one without
   * (0 items), no other difference.
   *
   * That is the scope being narrowed BEFORE the filter, and the narrowing not
   * being said — the same shape as a listing cap applied before its skip-list.
   * A run whose discoverer broke would order fewer items and then judge green
   * on the smaller universe, and this file's own comment says what was not
   * reached has to be NAMED rather than absent.
   *
   * So a declared-but-undiscovered page goes into the order carrying
   * `discovered: false`. It is a registry problem as well as a probe problem,
   * and the skill is told which it is looking at.
   */
  const ids = new Set([...seen, ...declared.filter((d) => String(d.id).startsWith("page:")).map((d) => d.id)])

  const items = [...ids]
    .map((id) => {
      const dec = decById.get(id) ?? {}
      return {
        id,
        url: pageUrl(base, id),
        priority: dec.priority ?? "P2",
        testId: dec.testId ?? null,
        probes: dec.probes ?? [],
        discovered: seen.has(id),
        // The whole objects, not just the ids. `why` is the field that lets an
        // agent unfamiliar with the skill act without asking anyone — and the
        // first version dropped it in a `.map(i => i.id)`.
        invariants: FREE_INVARIANTS.map((i) => ({ ...i })),
      }
    })
    .filter((i) => only.includes(i.priority))
    .sort((a, b) => a.priority.localeCompare(b.priority) || a.id.localeCompare(b.id))

  return {
    skill, artifactId, base, at: "probe",
    /**
     * Said out loud because a peer's runner broke on the alternative.
     *
     * Their harness logged in during one item and the NEXT item then found no
     * password field — and it only surfaced because the order's sort changed
     * when a declaration did. The order sorts by priority then id, so the
     * sequence is not stable across registry edits, and a skill that silently
     * depends on order will break on an unrelated change to somebody's
     * `priority` field.
     *
     * So the contract is stated rather than left to be inferred: each item must
     * stand on its own. `dom-test` says the same thing in its own words — "one
     * scenario, one context… never let scenario 2 depend on the state scenario
     * 1 left behind" — and an order that does not repeat it is relying on the
     * skill's author having read that line.
     */
    contract: {
      /**
       * A FRESH SESSION, not just its own navigation.
       *
       * The peer who asked for this contract then broke it while honouring the
       * word: their runner gave every item its own `goto` and shared one
       * browser context, so logging in during one item made the next one — the
       * login page — redirect away and fail to find a form. "Independent" read
       * as "navigates itself"; it means cookies, storage and auth state too.
       *
       * Worth spelling out because the natural implementation shares a context,
       * and sharing is completely invisible when you test one item at a time.
       */
      itemsAreIndependent: true,
      why:
        "each item gets a FRESH SESSION — its own cookies, storage and auth state — not just its own navigation. " +
        "The sequence is not stable across registry edits either: it sorts by priority then id, so a change to any " +
        "declaration's priority can reorder it, and an item that depends on the previous one breaks on an unrelated edit.",

      /**
       * What to do with `discovered: false`, which the same peer worked out by
       * walking it: the flag is a BRANCH, not a note.
       *
       *   loads and passes   discovery under-reported — a finding about the SCANNER
       *   404 or fails       the declaration outlived the page — about the REGISTRY
       *
       * Neither is "this deploy is broken", both need saying, and only the skill
       * can tell them apart because only the skill has the url and actually
       * opened it. Without this sentence the natural thing is to ignore the flag
       * and test normally — which files a finding about the scanner against the
       * page.
       */
      undiscovered: "for an item with `discovered: false`, answer IS IT THERE before IS IT GOOD: if the url loads and probes pass, discovery under-reported (a finding about the scanner); if it 404s or fails, the declaration is stale (a finding about the registry). Neither is a fault of this deploy.",
    },
    items,
  }
}

/**
 * The URL the skill should open.
 *
 * Resolved here rather than left to the caller: joining `base` to a feature id
 * means knowing to strip the `page:` prefix, and a peer who guessed right said
 * the cost of guessing WRONG is testing a different page and reporting PASS.
 * A silent success on the wrong page is the worst outcome this step can have.
 */
export function pageUrl(base, id) {
  const path = String(id).replace(/^page:/, "") || "/"
  return `${String(base ?? "").replace(/\/+$/, "")}${path.startsWith("/") ? path : `/${path}`}`
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

  /**
   * `artifactId` is the CLAIMED build; `observedArtifact` is the one the skill
   * actually read off the running site. Only the second is evidence.
   *
   * The first version had only the claim, and a peer measured that it is
   * vacuous under the flow I had recommended in the docs: a runner reads the
   * order and writes `artifactId: order.artifactId`, so the two are equal BY
   * CONSTRUCTION and the comparison cannot fail. It catches yesterday's file
   * (stale id) and misses today's file about yesterday's BUILD (copied id,
   * stale observation) — which is exactly what a pre-swap run produces, since
   * the site is still serving the previous artifact at that moment.
   *
   * I wrote that flow into the documentation. A check whose inputs come from
   * one source is a check with one source, however many fields it compares.
   */
  if (!result.artifactId) {
    faults.push("the result does not name an artifact, so nothing ties it to a deploy")
  } else if (result.artifactId !== order.artifactId) {
    faults.push(
      `the result was produced against ${result.artifactId} and this deploy is ${order.artifactId}. ` +
      `A stale green file is how a gate passes on evidence about a build nobody is running.`,
    )
  }
  // `sameObserved` rather than `!==`, so "both sides unreadable" can never read
  // as agreement — the rule that unifies the `?? 0` score, the empty-string
  // version field, and a /version endpoint answering "unknown".
  const artifactMatch = sameObserved(result.observedArtifact, order.artifactId, { what: "artifact" })
  if (artifactMatch.known && !artifactMatch.same) {
    faults.push(
      `the skill READ ${result.observedArtifact} off the running site while this deploy is ${order.artifactId}. ` +
      `The test ran, and it ran against a different build — a result that is correct in form and about the wrong thing.`,
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
 * AFTER THE SWAP, ABSENCE OF EVIDENCE MUST NOT UNDO A GOOD DEPLOY.
 *
 * The first version treated BLOCKED, NOT_EXERCISED and a missing row as
 * `error`, which the gate blocks on — so the step rolled back. A peer's first
 * real run hit exactly that: `/en/chat` came back BLOCKED because their test
 * account's password had been rotated by the pipeline's own sweep. The deploy
 * was fine. The pipeline replaced it with the previous build because of a
 * fixture.
 *
 * Their distinction is the right one and I did not have it: **"I could not
 * see it" costs a different amount before and after the swap.** Refusing at
 * verify costs "this does not ship today", which is free. Rolling back at
 * probe is an ACTION — swapping a good build out on the strength of a
 * measurement that did not happen.
 *
 * So only FAIL rolls back: positive evidence that something IS broken.
 * Everything that is merely missing becomes `unverified` — recorded, counted,
 * named in the outcome, and not a pass. `unmeasuredBlocks` exists for a caller
 * running this BEFORE a swap, where refusing is free again.
 *
 * The protection against this becoming decorative is that `unverified` is a
 * number the report has to print: "shipped, 3 of 4 P0 pages unverified" is a
 * sentence somebody acts on. Silence would not be.
 *
 * @param {boolean} [o.noiseIsFailure] dom-test's checklist table says a channel
 *   going red on an item whose condition held "is still a FAIL of that item —
 *   that is precisely what the manual tester would have noticed". Its
 *   `scenario.js` is looser and reports "PASS (with noise)".
 *
 *   The two halves of the skill DISAGREED, and this default has moved twice on
 *   that. Strict first, on the table. Then loose, because a peer measured that
 *   ~1 run in 4 on their app produces `net::ERR_NETWORK_CHANGED` from an SSE
 *   stream cut by navigation — noise nobody can act on — so strict would roll
 *   back a good deploy about every fourth deploy.
 *
 *   The contradiction has since been RESOLVED in the skill, strict, and
 *   `scenario.js` no longer reports "PASS (with noise)" at the top level. So
 *   this follows it: a default whose only justification was "the skill cannot
 *   decide" has no justification once the skill decides.
 *
 *   The noise measurement does not go away and is not an argument for loosening
 *   the gate — it is the argument for the work the skill now records as open:
 *   separating an ACTIONABLE red from transport noise. A consumer that softens
 *   instead is choosing to be wrong quietly rather than loudly.
 */
/**
 * @param {{ok:boolean, status?:number, unreachable?:string}|null} [o.liveness]
 *   vibeUbi's OWN look at `base`, taken just before judging. Not the skill's
 *   claim about it — this module's, one HTTP request, trusting nobody.
 *
 *   It exists because the fix for a false red opened a worse hole. Making
 *   BLOCKED non-blocking is right when the test side broke; it is exactly wrong
 *   when the DEPLOY broke, because a deploy that takes the site down makes the
 *   skill honestly report "I could not load the page" — and that would then
 *   ship. The most dangerous case and the benign one produce the same word.
 *
 *   The discriminator is not in the reason text. A rule that reads a
 *   caller-supplied reason is a rule an agent satisfies by writing better prose,
 *   and an enum is only structured prose unless something can CONTRADICT it. So:
 *
 *     base 2xx, skill says it could not see    → the deploy is alive, the test
 *                                                side is not → blocked, no rollback
 *     base 5xx or unreachable                  → not blocked. FAIL, and the kind
 *                                                that most needs a rollback
 *     no liveness taken                        → say so; do not assume alive
 *
 *   Same move as `deployProof`, which does not ask the deploy script whether it
 *   worked. Go and look.
 */
export function orderVerdict({ order, result, noiseIsFailure = true, unmeasuredBlocks = false, liveness = null }) {
  /**
   * `blocked` is not a new state — `verdictFor` already has it, and its comment
   * already says what this needs: "a dependency is unavailable — not caused by
   * this deploy, and rollback cannot fix it". Inventing `unverified` alongside
   * it would have been two names for one decision, which is how the same rule
   * ends up with two implementations that disagree.
   */
  /**
   * The site being down turns every absence into positive evidence.
   *
   * If the base is not serving, "the skill could not see the page" is no longer
   * ambiguous — it is the deploy, observed independently. Those items become
   * `fail`, which rolls back.
   */
  const siteDown = liveness != null && liveness.ok === false
  const absent = unmeasuredBlocks ? "error" : siteDown ? "fail" : "blocked"
  const admitted = skillResultAdmission({ order, result })
  if (!admitted.ok) {
    return {
      // An inadmissible result is a protocol failure, not a measurement one —
      // it blocks either way, because a result that cannot be tied to this
      // deploy is indistinguishable from one fabricated for it.
      cells: [{ feature: "probe", layer: "probe", priority: "P0", status: "error", reason: admitted.reason }],
      covered: 0,
      ordered: order.items.length,
    }
  }

  const byId = new Map(result.observed.map((o) => [o.id, o]))
  const cells = []

  if (!result.observedArtifact) {
    // Not a refusal: a skill that cannot read the artifact off the site is a
    // real situation. But the claim-vs-claim comparison it leaves behind is not
    // evidence, and saying nothing would let it read as if it were.
    cells.push({
      feature: "probe:artifact", layer: "probe", priority: "P0", status: "blocked",
      reason:
        `the skill did not report which artifact it actually observed, so the only tie between this result and this deploy ` +
        `is an id copied out of the order — equal by construction, and not evidence that the test ran against ${order.artifactId}.`,
    })
  }

  if (liveness == null) {
    // Not "assume it is up". A judgement made without looking is the thing this
    // parameter exists to replace, so it is named rather than silently defaulted.
    cells.push({
      feature: "probe:liveness", layer: "probe", priority: "P0", status: "blocked",
      reason: "no independent look at the base was taken before judging, so a failure of the test side cannot be told from a failure of the deploy",
    })
  } else if (liveness.ok && liveness.artifact && liveness.artifact !== order.artifactId) {
    // Our own look, at judge time: the site is serving something else now. The
    // skill's report may be perfectly true and about a build that is gone.
    cells.push({
      feature: "probe:artifact", layer: "probe", priority: "P0", status: "fail",
      reason:
        `the site is serving ${liveness.artifact} at probe time and this deploy is ${order.artifactId}. ` +
        `Something replaced it between prove and probe.`,
    })
  } else if (!liveness.ok) {
    cells.push({
      feature: "probe:liveness", layer: "probe", priority: "P0", status: "fail",
      reason:
        `the base is not serving (${liveness.unreachable ?? `HTTP ${liveness.status}`}) at probe time, and \`prove\` saw it serving this artifact minutes ago. ` +
        `Every item the skill could not reach is this, not a broken fixture.`,
    })
  }
  for (const item of order.items) {
    const got = byId.get(item.id)
    if (!got) {
      cells.push({
        feature: item.id, layer: "probe", priority: item.priority, status: absent,
        reason: `ordered and not reported. A result that omits an item says nothing about it, and a short green list must never read as full coverage.`,
      })
      continue
    }
    const v = String(got.verdict ?? "").toUpperCase()
    if (!SKILL_VERDICTS.includes(v)) {
      cells.push({
        feature: item.id, layer: "probe", priority: item.priority, status: absent,
        reason: `unrecognised verdict "${got.verdict}". An unknown verdict is not a pass — see what a misspelled severity used to cost.`,
      })
      continue
    }
    const status =
      v === "PASS" ? "pass"
      : v === "PASS_WITH_NOISE" ? (noiseIsFailure ? "fail" : "pass")
      : v === "FAIL" ? "fail"
      : absent    // BLOCKED and NOT_EXERCISED are "we do not know", not "it is broken"
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

  const ordered = order.items.length
  const unverified = cells.filter((c) => c.status === "blocked" && !c.volunteered && c.feature !== "probe:liveness" && c.feature !== "probe:artifact").length
  return {
    cells,
    ordered,
    covered: order.items.filter((i) => byId.has(i.id)).length,
    unverified,
    // The number a report has to print. "shipped, 3 of 4 P0 pages unverified"
    // is a sentence somebody acts on; silence is how this step becomes decoration.
    verified: ordered - unverified - cells.filter((c) => c.status === "fail" && !c.volunteered && c.feature !== "probe:liveness" && c.feature !== "probe:artifact").length,
  }
}
