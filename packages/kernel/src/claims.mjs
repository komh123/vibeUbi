/**
 * claims.mjs — four ways a true statement answers the wrong question.
 *
 * Every rule in here comes from a defect where nothing was miscalculated. The
 * arithmetic held, the check ran, the message rendered. What failed was the
 * MATCH between the claim and the thing it was about, and that is invisible to
 * a test that only asks whether the code did what it says.
 *
 * All four were reported by a consumer of this kernel, from their own record,
 * each a class they had hit more than once. None of the existing rules caught
 * them — verified by running `findRule` on the sentences they said they would
 * have searched with, before any of this existed. All five missed.
 */

/* ───────────────────────────────────────────────────────────────────────────
 * 1 · A remediation that cannot resolve the condition it is attached to.
 * ─────────────────────────────────────────────────────────────────────────── */

/**
 * Selecting a local machine returned "update Rabi Local on this computer" for
 * two different causes. For one of them the machine is configured with a
 * container sandbox, which *structurally cannot* issue the authorization —
 * updating a hundred times changes nothing. The field that separates the two
 * (`info.sandbox`) was already in the payload and nobody read it.
 *
 * `declaredFieldsAreRead` catches the unread field. It does not catch the
 * user-visible defect, which is the false remediation, and that is the one
 * people actually pay for: the message is confident, actionable, and sends them
 * somewhere nothing can happen. A remediation is a claim — *doing this will
 * change your situation* — and like any claim it can be checked.
 *
 * @param {object} o
 * @param {string} o.cause        which condition actually fired
 * @param {string} o.remediation  what the user is told to do
 * @param {readonly string[]} o.resolves  causes this remediation can actually clear
 */
export function remediationVerdict({ cause, remediation, resolves = [], seen = "" }) {
  const c = String(cause ?? "").trim()
  const r = String(remediation ?? "").trim()

  if (!c) {
    return {
      ok: false, known: false,
      reason:
        `a remediation was offered without recording which condition fired. ` +
        `Nothing can say whether it helps, which is the same position the user is in.`,
    }
  }
  if (!r) return { ok: true, known: true, reason: `no remediation offered for "${c}" — honest` }

  if (!resolves.length) {
    return {
      ok: false, known: false,
      reason:
        `"${r}" is offered for "${c}" and nothing declares what that action can actually resolve. ` +
        `An undeclared remediation cannot be wrong, which is exactly why it is never found to be.`,
    }
  }
  if (!resolves.includes(c)) {
    return {
      ok: false, known: true, cause: c, remediation: r,
      reason:
        `"${r}" is offered when "${c}" fires, and "${c}" is not in the list of conditions that action resolves ` +
        `(${resolves.slice(0, 4).join(", ")}). The user will do it, it will not help, and they will do it again — ` +
        `a confident remediation for an unresolvable condition costs more than no message at all.` +
        (seen ? ` What they see: ${seen}` : ""),
    }
  }
  return { ok: true, known: true, cause: c, remediation: r, reason: `"${r}" can resolve "${c}"` }
}

/* ───────────────────────────────────────────────────────────────────────────
 * 2 · One rule, more than one implementation.
 * ─────────────────────────────────────────────────────────────────────────── */

/**
 * Four instances in one codebase: a guardrail with a gate copy and a report
 * copy; an approval posture duplicated instead of extended; a `deviceOnly` rule
 * one call site honoured and another did not; a grant-replacement rule one path
 * had and another lacked. Every time, somebody changed one copy.
 *
 * `crossLayerNames` is this shape across a boundary, where the two sides are
 * *meant* to be separate and only their names must agree. This is the harder
 * one: the copies are not meant to exist at all, so nothing declares them a
 * pair, and each is individually correct and individually tested.
 *
 * The check is a cross-comparison — run every implementation over the same
 * inputs and require identical answers. The cases matter more than the code: a
 * case set on which all copies agree proves nothing, so the report says how
 * many cases actually discriminated.
 *
 * @param {object} o
 * @param {string} o.rule
 * @param {Record<string, (x:any)=>any>} o.implementations  name → the copy
 * @param {readonly any[]} o.cases
 */
export function implementationsAgree({ rule = "this rule", implementations = {}, cases = [] }) {
  const names = Object.keys(implementations)

  if (names.length < 2) {
    return { ok: true, known: true, names, reason: `${rule} has ${names.length} implementation(s) — nothing to diverge` }
  }
  if (!cases.length) {
    return {
      ok: false, known: false, names,
      reason:
        `${rule} has ${names.length} implementations (${names.join(", ")}) and no cases to compare them on. ` +
        `Two copies that were never run against the same input agree only by assumption.`,
    }
  }

  const disagreements = []
  let discriminating = 0
  for (const [i, input] of cases.entries()) {
    const answers = names.map((n) => {
      try { return { n, v: JSON.stringify(implementations[n](input)) } }
      catch (e) { return { n, v: `threw: ${e?.message ?? e}` } }
    })
    const distinct = new Set(answers.map((a) => a.v))
    if (distinct.size > 1) {
      discriminating++
      if (disagreements.length < 3) {
        disagreements.push(`case ${i}: ` + answers.map((a) => `${a.n}=${String(a.v).slice(0, 40)}`).join(" vs "))
      }
    }
  }

  if (disagreements.length) {
    return {
      ok: false, known: true, names, disagreements,
      reason:
        `${rule} is implemented ${names.length} times and the copies disagree on ${discriminating} of ${cases.length} case(s): ` +
        `${disagreements.join("; ")}. Each copy is correct on its own and passes its own tests; somebody changed one of them.`,
    }
  }
  return {
    ok: true, known: true, names, agreedOn: cases.length,
    reason:
      `${names.length} implementations of ${rule} agree on all ${cases.length} case(s). ` +
      `They still want collapsing into one — agreement today is not a property of the code, it is a property of this case set.`,
  }
}

/* ───────────────────────────────────────────────────────────────────────────
 * 3 · The count is real and measures the wrong thing.
 * ─────────────────────────────────────────────────────────────────────────── */

/**
 * A search backend was declared working from result COUNTS; the results for one
 * query were shopping pages. Same shape as "156 services listed, 0 connected".
 *
 * This is not `vacuousComparison` — nothing here is empty and nothing could not
 * have failed. The count is true. It is simply not evidence for the claim being
 * made, because nothing looked at the items, and "how many came back" and "are
 * any of them what I asked for" are different measurements that happen to be
 * available at the same moment.
 *
 * @param {object} o
 * @param {number} o.counted   how many came back
 * @param {number} [o.checked] how many were actually examined for fitness
 * @param {number} [o.fit]     how many of those were fit for the purpose
 * @param {string} [o.claim]
 */
export function countIsNotFitness({ counted, checked, fit, claim = "this works" }) {
  if (!Number.isFinite(counted)) {
    return { ok: false, known: false, reason: `no count was produced, so "${claim}" rests on nothing.` }
  }
  if (!Number.isFinite(checked) || checked <= 0) {
    return {
      ok: false, known: false, counted,
      reason:
        `"${claim}" is being concluded from a count of ${counted}, and nothing examined the items. ` +
        `The count is true and is not evidence: "how many came back" and "are any of them what I asked for" ` +
        `are different measurements that happen to arrive together.`,
    }
  }
  if (!Number.isFinite(fit)) {
    return { ok: false, known: false, counted, checked, reason: `${checked} item(s) were examined and no fitness was recorded.` }
  }
  if (fit <= 0) {
    return {
      ok: false, known: true, counted, checked, fit,
      reason:
        `${counted} item(s) came back, ${checked} were examined, and ${fit} were fit for "${claim}". ` +
        `A healthy count over an unfit population is the most convincing wrong answer available.`,
    }
  }
  return { ok: true, known: true, counted, checked, fit, reason: `${fit}/${checked} examined item(s) fit "${claim}"` }
}

/* ───────────────────────────────────────────────────────────────────────────
 * 4 · Right arithmetic, wrong population.
 * ─────────────────────────────────────────────────────────────────────────── */

/**
 * A warning was issued about production behaviour, computed from a RECENT
 * sample rather than from the set that had actually passed the gate and reached
 * production. The percentage was correct. It described a different group than
 * the one the sentence named, so the warning was false and was acted on.
 *
 * Nothing in a number says which population it came from, which is why this
 * survives review: the figure is checkable and the denominator is not written
 * down anywhere near it.
 *
 * @param {object} o
 * @param {string} o.claimAbout  the population the statement is about
 * @param {string} o.measured    the population the number came from
 * @param {number} [o.n]
 */
export function populationVerdict({ claimAbout, measured, n, statistic = "this number" }) {
  const want = String(claimAbout ?? "").trim()
  const got = String(measured ?? "").trim()

  if (!want || !got) {
    return {
      ok: false, known: false,
      reason:
        `${statistic} does not record ${!want ? "which population it is about" : "which population it was measured from"}. ` +
        `Nothing in a figure says where its denominator came from, so this cannot be caught by reading it.`,
    }
  }
  if (want !== got) {
    return {
      ok: false, known: true, claimAbout: want, measured: got, n,
      reason:
        `${statistic} is stated about "${want}" and was measured over "${got}"${Number.isFinite(n) ? ` (n=${n})` : ""}. ` +
        `The arithmetic is fine; the denominator is a different group, so the sentence is false in a way no ` +
        `recomputation will reveal.`,
    }
  }
  if (Number.isFinite(n) && n <= 0) {
    return { ok: false, known: false, claimAbout: want, measured: got, n, reason: `${statistic} covers "${want}" with n=${n}.` }
  }
  return { ok: true, known: true, claimAbout: want, measured: got, n, reason: `${statistic} measured over the population it names` }
}
