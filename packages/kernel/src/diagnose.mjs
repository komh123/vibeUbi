/**
 * diagnose.mjs — run every check, stop at none, and never let the result pass as evidence.
 *
 * ## Why this exists
 *
 * A gate stops at its first red, and it is right to: a deploy must not proceed
 * past a failure. But fixing failures one at a time from a gate like that is the
 * slowest possible loop. Measured on one deploy (2026-10-07 → 10-08): fifteen
 * full chain runs over ~10 hours, and each one surfaced exactly one problem,
 * because the steps after the red never ran. Five of those fifteen were the same
 * fact (a pinned runtime version) hardcoded in five places — every one of them
 * was already broken on the first run, and each waited its turn to be seen.
 *
 * A diagnostic run answers the other question — "what is broken, all of it?" —
 * by running every step regardless of the ones before it.
 *
 * ## The one rule
 *
 * **A diagnostic run is never deploy evidence.** It ran steps out of their
 * contract (a later step after an earlier red may be testing something the
 * earlier red already invalidated), so "it was green" means nothing about
 * whether the gate would have passed. `countsAsEvidence` is the single place a
 * consumer asks; a report it was not written for (no `kind`) still has to be
 * full, green and un-narrowed.
 *
 * Diagnostics are also written somewhere a gate does not look
 * (`.vibeubi/diagnostics/`, not `.vibeubi/runs/`), so a consumer that forgot to
 * ask cannot pick one up by accident. Two fences, because the first one is a
 * convention and conventions get forgotten.
 */

export const DIAGNOSTIC_KIND = "diagnostic"

/** Where diagnostic reports go, relative to the project root. Never where gate reports live. */
export const DIAGNOSTICS_DIR = ".vibeubi/diagnostics"

/**
 * @typedef {{ name: string, ok: boolean, code?: number, timedOut?: boolean, oom?: string|null, reason?: string|null, ms?: number, passed?: number }} DiagnosticResult
 */

/**
 * Fold per-step results into one report. Every failure is listed, in run order,
 * with the reason a person can act on — not just "exit 1".
 *
 * @param {readonly DiagnosticResult[]} results
 */
export function diagnoseSummary(results) {
  const rows = [...(results ?? [])]
  const failed = rows.filter((r) => !r.ok).map((r) => ({
    name: r.name,
    why: r.timedOut ? "timed out" : r.oom ? "ran out of heap" : r.reason ? r.reason : `exited ${r.code ?? "?"}`,
  }))
  return {
    kind: DIAGNOSTIC_KIND,
    evidence: false,
    total: rows.length,
    passed: rows.length - failed.length,
    failed,
    // `clean`, not `ok`: a gate that reads `report.ok` must not find a true here.
    clean: rows.length > 0 && failed.length === 0,
    headline: rows.length === 0
      ? "nothing ran — a diagnostic over zero steps proves nothing"
      : failed.length === 0
        ? `all ${rows.length} step(s) passed in a diagnostic run — now run the real gate; this is not evidence`
        : `${failed.length} of ${rows.length} step(s) failed: ${failed.map((f) => f.name).join(", ")}`,
  }
}

/**
 * May this report be used as evidence that a gate passed?
 *
 * @param {unknown} report
 * @param {{ phase?: string, sourceTree?: string }} [want]
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function countsAsEvidence(report, want = {}) {
  if (!report || typeof report !== "object") return { ok: false, reason: "no report" }
  const r = /** @type {Record<string, unknown>} */ (report)
  if (r.kind === DIAGNOSTIC_KIND || r.diagnostic === true || r.evidence === false) {
    return { ok: false, reason: "a diagnostic run is never deploy evidence — it ran steps past a red on purpose" }
  }
  if (r.narrowed === true) return { ok: false, reason: "a narrowed run (--only) covers some steps, not the gate" }
  if (r.ok !== true) return { ok: false, reason: "the run did not pass" }
  if (want.phase && r.phase !== want.phase) return { ok: false, reason: `phase is ${String(r.phase)}, not ${want.phase}` }
  if (want.sourceTree && r.sourceTree !== want.sourceTree) {
    return { ok: false, reason: "the evidence is for a different source tree — any edit, even to a test, invalidates it" }
  }
  return { ok: true }
}
