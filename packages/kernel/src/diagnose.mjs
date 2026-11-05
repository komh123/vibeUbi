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

import { sameObserved } from "./proof.mjs"

export const DIAGNOSTIC_KIND = "diagnostic"

// Fingerprints are strings. Reuse the kernel's unreadable-value semantics;
// equality of null, empty strings, numbers or objects cannot establish identity.
const sameFingerprint = (a, b) => sameObserved(
  typeof a === "string" ? a : null,
  typeof b === "string" ? b : null,
).same

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
 * @param {{ phase?: string, sourceTree?: string, buildInputsHash?: string, testInputsHash?: string }} [want]
 *   `buildInputsHash` / `testInputsHash` bind evidence to the two halves of the tree (see inputs.mjs).
 *   A build-phase report depends on the build half only; every other phase depends on both, so
 *   asking for acceptance evidence with only one of them is refused rather than half-checked.
 *   Build/split reports require a requested fingerprint binding (or a whole-tree binding).
 *   Every requested fingerprint must be a nonempty string on both sides.
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
/** Does any step row in this report say `skipped`? Looks only at the shapes that carry per-step status. */
function hasSkippedStep(r) {
  const rows = [
    ...(Array.isArray(r.steps) ? r.steps : r.steps && typeof r.steps === "object" ? Object.values(r.steps) : []),
    ...(Array.isArray(r.outcome?.items) ? r.outcome.items : []),
  ]
  return rows.some((row) => row && typeof row === "object" && row.status === "skipped")
}

export function countsAsEvidence(report, want = {}) {
  if (!report || typeof report !== "object") return { ok: false, reason: "no report" }
  const r = /** @type {Record<string, unknown>} */ (report)
  if (r.kind === DIAGNOSTIC_KIND || r.diagnostic === true || r.evidence === false) {
    return { ok: false, reason: "a diagnostic run is never deploy evidence — it ran steps past a red on purpose" }
  }
  if (r.narrowed === true) return { ok: false, reason: "a narrowed run (--only) covers some steps, not the gate" }
  if (r.ok !== true) return { ok: false, reason: "the run did not pass" }
  if (hasSkippedStep(r)) return { ok: false, reason: "a step was skipped (environment-blocked); a skipped step proves nothing, so neither does the run" }
  if (want.phase && r.phase !== want.phase) return { ok: false, reason: `phase is ${String(r.phase)}, not ${want.phase}` }
  const wholeTree = Object.hasOwn(want, "sourceTree")
  if (wholeTree && !sameFingerprint(r.sourceTree, want.sourceTree)) {
    return { ok: false, reason: "the evidence is unreadable or for a different source tree — any edit, even to a test, invalidates it" }
  }
  const split = Object.hasOwn(want, "buildInputsHash") || Object.hasOwn(want, "testInputsHash") ||
    (!wholeTree && ((want.phase ?? r.phase) === "build" || Object.hasOwn(r, "buildInputsHash") || Object.hasOwn(r, "testInputsHash")))
  if (split) {
    const needsTests = want.phase !== "build"
    if (needsTests && (!Object.hasOwn(want, "buildInputsHash") || !Object.hasOwn(want, "testInputsHash"))) {
      return { ok: false, reason: "evidence for a non-build phase must be asked for with both buildInputsHash and testInputsHash as nonempty strings" }
    }
    if (!sameFingerprint(r.buildInputsHash, want.buildInputsHash)) {
      return { ok: false, reason: "the build inputs are unreadable or different — a nonempty buildInputsHash must be observed and requested" }
    }
    if (needsTests && !sameFingerprint(r.testInputsHash, want.testInputsHash)) {
      return { ok: false, reason: "the test inputs are unreadable or different — an acceptance script, fixture or ledger changed" }
    }
  }
  return { ok: true }
}
