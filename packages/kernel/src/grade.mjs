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

export function score(findings) {
  const s = findings.reduce((acc, f) => acc - (WEIGHT[String(f.severity).toLowerCase()] ?? 0), 100)
  return Math.max(0, s)
}

export function grade(findings) {
  const n = score(findings)
  for (const [letter, floor] of BANDS) if (n >= floor) return { grade: letter, score: n }
  return { grade: "F", score: n }
}

/** Severities at or above which a NEW finding blocks. Case-insensitive on purpose:
 *  scanners spell them CRITICAL/HIGH, and a gate that silently matches nothing
 *  because of letter case is worse than no gate. */
export const DEFAULT_FAIL_ON = ["critical", "high"]

export function atOrAbove(severity, failOn = DEFAULT_FAIL_ON) {
  const i = SEVERITIES.indexOf(String(severity).toLowerCase())
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
  const fresh = findings.filter((f) => !known.has(f.fingerprint))
  return {
    new: fresh,
    known: findings.filter((f) => known.has(f.fingerprint)),
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
