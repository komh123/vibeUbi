/**
 * grade.mjs — scoring findings, and the baseline that keeps the gate alive.
 *
 * TWO RULES, both learned the hard way:
 *
 * 1. Only block on findings this change INTRODUCED. A gate that blocks on
 *    known debt is a gate people DELETE. Known debt still gets named in every
 *    report, so it cannot quietly become invisible either.
 *
 * 2. A fingerprint carries identity, never evidence. No line numbers (they
 *    move), no timestamps, and above all no secret bodies — a security scanner
 *    that writes a key into a CI log IS a security incident.
 */

export const SEVERITIES = ["critical", "high", "medium", "low", "info"]
const WEIGHT = { critical: 25, high: 10, medium: 4, low: 1, info: 0 }
const BANDS = [["A", 90], ["B", 75], ["C", 60], ["D", 40]]

/**
 * A severity this scorer does not recognise is NOT free.
 *
 * `WEIGHT[...] ?? 0` meant a finding whose severity was misspelled, or came
 * from a rule using a different vocabulary, cost exactly nothing and did not
 * block — silently, while appearing in the report like any other row. A peer
 * session made the general version of this point today: a defensive fallback is
 * the thing that hides the defect, because it turns "this value is not what I
 * expect" into a plausible number nobody questions.
 *
 * Unknown weighs as `high`. Not as `critical`, which would make a typo louder
 * than a real critical; not as zero, which is what it was.
 */
export function score(findings) {
  const s = findings.reduce((acc, f) => acc - weightOf(f.severity), 100)
  return Math.max(0, s)
}

export function weightOf(severity) {
  const w = WEIGHT[String(severity).toLowerCase().trim()]
  return w ?? WEIGHT.high
}

/** Severities that no rule in this run spelled the way the scorer expects. */
export function unknownSeverities(findings) {
  return [...new Set(findings
    .map((f) => String(f.severity ?? "").toLowerCase().trim())
    .filter((s) => !(s in WEIGHT)))]
}

/**
 * A grade is a claim about COVERAGE, so it cannot be issued without any.
 *
 * Measured on a real project whose stack no adapter recognises: nothing was
 * discovered, so no route rule ran, and a codebase containing an ungated
 *
 *     POST /api/admin/delete_everything
 *
 * came back **grade A, score 100, "clean"**. The skip was recorded — in a
 * `skipped` array the grade never read. An empty registry scoring full marks
 * is the exact failure this product exists to remove, sitting in the product.
 *
 * So: if a layer was asked for and could not run, no letter is issued. Not A,
 * not F — F is also a claim, and claiming a bad score you did not measure
 * teaches people to ignore the number. The grade is WITHHELD and says what was
 * never looked at.
 *
 * @param {readonly object[]} findings
 * @param {readonly string[]} [unmeasured] layers requested that produced no judgement
 */
export function grade(findings, unmeasured = []) {
  if (unmeasured.length > 0) {
    return {
      grade: "—",
      score: null,
      unmeasured: [...unmeasured],
      reason:
        `no grade: ${unmeasured.length} requested check(s) never ran (${unmeasured.join("; ")}). ` +
        `A score over a scan that looked at nothing is worse than no score, because it is believed.`,
    }
  }
  const n = score(findings)
  for (const [letter, floor] of BANDS) if (n >= floor) return { grade: letter, score: n }
  return { grade: "F", score: n }
}

/** Did the run measure anything at all? Separated so the gate can ask directly. */
export function coverageOf({ layers = [], skipped = [] }) {
  const blocked = skipped.filter((s) => !/not requested|not configured — skipped by choice/i.test(String(s)))
  return { requested: layers.length, unmeasured: blocked, ok: blocked.length === 0 }
}

/** Severities at or above which a NEW finding blocks. Case-insensitive on purpose:
 *  scanners spell them CRITICAL/HIGH, and a gate that silently matches nothing
 *  because of letter case is worse than no gate. */
export const DEFAULT_FAIL_ON = ["critical", "high"]

export function atOrAbove(severity, failOn = DEFAULT_FAIL_ON) {
  // Same rule as `weightOf`: unrecognised reads as `high`, so a typo cannot be
  // the quietest possible way to disable a gate.
  const raw = String(severity).toLowerCase().trim()
  const i = SEVERITIES.includes(raw) ? SEVERITIES.indexOf(raw) : SEVERITIES.indexOf("high")
  const floor = Math.max(...failOn.map((s) => SEVERITIES.indexOf(String(s).toLowerCase())).filter((x) => x >= 0))
  return i >= 0 && i <= floor
}

/**
 * Compare a run against the accepted baseline.
 * @param {readonly {fingerprint:string, severity:string}[]} findings
 * @param {readonly {fingerprint:string}[]} baseline
 */
export function baselineDiff(findings, baseline, failOn = DEFAULT_FAIL_ON) {
  const known = new Set(baseline.map((b) => b.fingerprint))
  const seen = new Set(findings.map((f) => f.fingerprint))
  /**
   * An inadmissible finding is never "known", whatever the baseline says.
   *
   * `baselineAdmission` refuses to WRITE one, but a baseline file is a text
   * file a person can edit, and this is the gate's last line: a finding whose
   * content is "this check did not run" must keep blocking even if its
   * fingerprint has been pasted in. Measured before this: grade stayed "—" and
   * the exit code went 1 → 0, which is the number CI actually reads.
   */
  const fresh = findings.filter((f) => f.admissible === false || !known.has(f.fingerprint))
  return {
    new: fresh,
    // Symmetrical on purpose. Leaving it in `known` as well as `new` would
    // report the same finding as both accepted debt and a new problem, and the
    // report reader would reasonably believe the reassuring half.
    known: findings.filter((f) => f.admissible !== false && known.has(f.fingerprint)),
    resolved: baseline.filter((b) => !seen.has(b.fingerprint)),
    blocking: fresh.filter((f) => atOrAbove(f.severity, failOn)),
  }
}

/** How long the oldest accepted debt has been accepted. This number is the
 *  whole reason a hosted ledger is worth paying for. */
export function debtAge(baseline, now) {
  const dated = baseline.filter((b) => Number.isFinite(b.acceptedAt))
  if (dated.length === 0) return null
  const oldest = Math.min(...dated.map((b) => b.acceptedAt))
  return { days: Math.floor((now - oldest) / 86_400_000), since: oldest }
}
