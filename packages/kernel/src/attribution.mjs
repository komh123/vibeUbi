/**
 * attribution.mjs — was this red caused by THIS deploy?
 *
 * The gate's entire justification is that undoing the deploy undoes the
 * problem. A failure that ALSO happens on the build being rolled back TO
 * fails that test.
 *
 * Measured: one release was reverted by exactly one such cell. Against the
 * restored build the same check took 124s (fail), 7s, 28s on three runs.
 *
 * The remedy is NOT a longer deadline. A coin flip wired to a rollback is
 * worse than no gate at all: it trains people to re-run until green, which is
 * the habit that ships a real regression.
 *
 * So: re-check the blocking cells ONCE.
 *   survives the retry → the deploy owns it → roll back
 *   passes the retry   → the deploy is exonerated, and the flake is REPORTED,
 *                        because a gate that goes quiet about what it could
 *                        not attribute is the gate nobody believes later.
 */

import { verdictFor } from "./verdict.mjs"

/** @param {readonly import("./verdict.mjs").Cell[]} cells */
export function needsAttribution(cells) {
  return verdictFor(cells).ship === false
}

/**
 * The `--only` selector that narrows a re-check to one failing feature.
 *
 * With several features to re-check, narrowing to one would silently leave
 * the others unattributed — and an unattributed cell must keep blocking. So
 * return "" and let the caller re-run the whole layer.
 *
 * @param {readonly import("./verdict.mjs").Cell[]} cells
 */
export function retrySelector(cells) {
  const ids = [...new Set(cells.map((c) => c.feature).filter(Boolean))]
  if (ids.length !== 1) return ""
  return `id=${ids[0]}`
}

export const cellKey = (c) => `${c.feature ?? "?"}|${c.layer ?? "?"}|${c.role ?? ""}`

/**
 * Fold a re-check into a final verdict.
 *
 * A cell absent from the retry is treated as STILL FAILING, never as passed:
 * a retry that could not run (wrong selector, layer error) must not be able
 * to launder a red into a green. That exact bug shipped once — a malformed
 * selector made the re-check exit 2 with no report, and the fallback was the
 * only thing that kept a bad build from being cleared.
 *
 * @param {readonly import("./verdict.mjs").Cell[]} first
 * @param {readonly import("./verdict.mjs").Cell[]} retry
 */
export function attributedVerdict(first, retry) {
  const blocking = verdictFor(first).blocking
  const retryByKey = new Map(retry.map((c) => [cellKey(c), c]))

  const owned = []
  const exonerated = []
  for (const c of blocking) {
    const again = retryByKey.get(cellKey(c))
    if (!again) { owned.push(c); continue }          // absent → still failing
    if (again.status === "pass") exonerated.push(c)
    else owned.push(c)
  }

  const verdict = verdictFor(owned)
  return {
    ...verdict,
    owned,
    exonerated,
    reason:
      exonerated.length > 0
        ? `${verdict.reason}${verdict.reason ? " · " : ""}${exonerated.length} cell(s) passed on re-check — NOT caused by this deploy, reported anyway`
        : verdict.reason,
  }
}
