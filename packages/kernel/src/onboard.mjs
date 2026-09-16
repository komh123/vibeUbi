/**
 * onboard.mjs — one command, four stages, and the stops a human owns.
 *
 * WHY THIS IS A SEPARATE FILE AND NOT A SCRIPT.
 *
 * `trunk init` and `semgrep --config=auto` already prove the shape people want:
 * one command, any repository, no config to write first. VibeUbi can copy that
 * for three of its four stages. It cannot copy it for the fourth, and pretending
 * otherwise is how a gate becomes decoration:
 *
 *   - the PROOF endpoint cannot be guessed. Guess it wrong and no other check
 *     anywhere reports an error — the gate simply issues green forever.
 *   - the six NARROWING actions cannot be guessed, because an agent guessing
 *     them is an agent lowering its own pass mark.
 *
 * So the honest promise is not "one command, no questions". It is: ONE COMMAND,
 * THE FEWEST QUESTIONS, AND EVERY QUESTION IS ONE ONLY YOU CAN ANSWER.
 *
 * THE CONFIG IS THE STATE. There is no progress file to get out of sync with
 * reality — the stage is derived from what the config and the last scan
 * actually contain, so re-running resumes, and deleting something walks it
 * back. A separate state file would be a fifth thing that is declared and
 * believed and can disagree with the truth.
 */

export const STAGES = Object.freeze([
  { id: "detect",    what: "work out the stack, the commands, and how a deploy could be proved" },
  { id: "inventory", what: "list what exists — writes nothing, judges nothing" },
  { id: "claim",     what: "every discovered thing gets an owner, a priority and a role" },
  { id: "baseline",  what: "today's findings become recorded debt, so the gate blocks only on NEW" },
  { id: "gated",     what: "the gate is on" },
])

const blank = (v) => v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0)

/**
 * Which stage is this project in, and what is it waiting on?
 *
 * Pure: it is handed what was observed, never goes and looks. That is what
 * lets every branch below be tested without a project to test it against.
 *
 * @param {object} o
 * @param {object|null} o.config  the project's config, or null if there is none yet
 * @param {object} [o.probe]      what `init` could work out on its own
 * @param {object} [o.scan]       the last scan: { findings, coverage }
 * @param {object} [o.discovered] { total, orphans } from the registry
 */
export function onboardStage({ config, probe = {}, scan = null, discovered = null }) {
  const asks = []
  const ask = (id, question, why) => asks.push({ id, question, why })

  if (!config) {
    return stage("detect", asks, "no config yet — run it and I will write one from what I can see")
  }

  /* ── 0 · can this project be measured at all? ─────────────────────────── */
  if (blank(config.plugins) && blank(probe.framework)) {
    ask("discoverer",
      "no adapter recognises this stack — which one discovers your features?",
      "without a discoverer the registry is EMPTY, and an empty registry used to score full marks")
  }
  if (blank(config.gateTokens)) {
    ask("gateTokens",
      "name your auth helper(s) — the function a guarded route actually calls",
      "until this is named EVERY route reads as ungated, and the first report is a wall of red nobody trusts")
  }
  if (blank(config.versionPath)) {
    ask("proof",
      "which endpoint echoes the id of the build that is running?",
      "this is the one field that is never guessed: wrong here and nothing else reports an error, the gate just issues green")
  }
  if (asks.length) return stage("detect", asks)

  /* ── 1 · has anything been looked at? ─────────────────────────────────── */
  if (!discovered) return stage("inventory", asks, "nothing discovered yet — this step writes nothing")
  if (discovered.total === 0) {
    ask("discoverer",
      `the adapter ran and found nothing in this project`,
      "a discoverer that returns zero is indistinguishable from a clean project, so this is a stop, not a pass")
    return stage("inventory", asks)
  }

  /* ── 2 · does everything have an owner? ───────────────────────────────── */
  if (discovered.orphans > 0) {
    ask("claim",
      `${discovered.orphans} of ${discovered.total} discovered thing(s) have no declaration`,
      "adopt drafts these; you correct two fields — priority and requiredRole — because those are the two the gate reads")
    return stage("claim", asks)
  }

  /* ── 3 · is today's debt written down? ────────────────────────────────── */
  if (scan && !scan.coverage?.ok) {
    ask("coverage",
      `the last scan could not run ${scan.coverage?.unmeasured?.length ?? 0} requested check(s)`,
      "a baseline drawn over checks that never ran records a coverage hole as accepted debt")
    return stage("baseline", asks)
  }
  const blocking = scan?.blocking?.length ?? 0
  if (blocking > 0 && blank(config.baseline)) {
    ask("baseline",
      `${blocking} finding(s) would block every ship from today onward`,
      "on an existing project a gate that blocks on day-one debt is a gate people DELETE. Record it, with a reason each, and block only on new")
    return stage("baseline", asks)
  }

  return stage("gated", asks)
}

function stage(id, asks, note = null) {
  const i = STAGES.findIndex((s) => s.id === id)
  return {
    stage: id,
    index: i,
    of: STAGES.length,
    what: STAGES[i].what,
    blocked: asks.length > 0,
    asks,
    note,
    done: id === "gated",
  }
}

/**
 * Sort findings into what may be recorded as debt and what may not.
 *
 * ESLint's `--suppress-all` writes a count per file per rule and asks nothing.
 * That is right for `no-undef` and wrong for "a private key is in git history":
 * the second needs a person's name against it and a date, or in a year nobody
 * can tell a decision from an accident.
 *
 * So each finding needs a decision, and `baselineAdmission` REFUSES two of the
 * three possible answers — a false positive must be fixed in the rule, never
 * absorbed, because a baseline entry is a signed statement that the finding is
 * real.
 *
 * @param {readonly object[]} findings
 * @param {Record<string, {verdict?:string, reason?:string}>} decisions keyed by fingerprint
 * @param {(f:object)=>{admit:boolean, reason?:string}} admission
 * @param {number} now
 */
export function baselinePlan(findings, decisions, admission, now = Date.now()) {
  const admit = [], refused = [], undecided = []
  for (const f of findings) {
    const d = decisions[f.fingerprint]
    if (!d) { undecided.push(f); continue }
    const candidate = { ...f, verdict: d.verdict ?? "real", reason: d.reason }
    const verdict = admission(candidate)
    if (!verdict.admit) { refused.push({ finding: f, why: verdict.reason, verdict: candidate.verdict }); continue }
    admit.push({
      fingerprint: f.fingerprint,
      rule: f.rule,
      severity: f.severity,
      verdict: candidate.verdict,
      reason: candidate.reason,
      acceptedAt: now,
    })
  }
  return { admit, refused, undecided }
}

/**
 * Which recorded debts no longer exist?
 *
 * ESLint learned this one the expensive way and shipped `--prune-suppressions`:
 * an entry for a violation that has been fixed keeps standing, and the thing it
 * asserts — "we looked at this and accepted it" — is no longer true. Worse, it
 * silently re-exempts the NEXT occurrence, so a debt somebody paid off becomes
 * permanent cover for the same defect coming back.
 *
 * Reported as good news, because that is what it is: work that got done.
 */
export function prunePlan(baseline = [], findings = []) {
  const live = new Set(findings.map((f) => f.fingerprint))
  const stale = baseline.filter((b) => !live.has(b.fingerprint))
  return {
    stale,
    keep: baseline.filter((b) => live.has(b.fingerprint)),
    reason: stale.length
      ? `${stale.length} recorded debt(s) no longer appear — they were fixed. Left in place they would silently exempt the same defect if it came back.`
      : null,
  }
}
