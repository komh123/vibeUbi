/**
 * attribution.mjs — was this red caused by THIS deploy?
 *
 * The gate's entire justification is that undoing the deploy undoes the
 * problem. A failure that ALSO happens on the build being rolled back TO fails
 * that test.
 *
 * Measured: one release was reverted by exactly one such cell. Against the
 * restored build the same check took 124s (fail), 7s, 28s on three runs.
 *
 * The remedy is NOT a longer deadline. A coin flip wired to a rollback is worse
 * than no gate at all: it trains people to re-run until green, which is the
 * habit that ships a real regression.
 *
 * ── WHAT A RE-CHECK CAN AND CANNOT ESTABLISH ─────────────────────────────────
 *
 * This file claimed the two-sided test above and performed a one-sided one for
 * as long as it has existed. The re-check runs on the SAME build, so a cell that
 * passes the second time is INTERMITTENT — and the reason string said "NOT
 * caused by this deploy", which does not follow. A deploy can perfectly well
 * introduce an intermittent failure.
 *
 * A consumer found the identical sentence in their own gate and stated the
 * general rule, which is now this module's contract:
 *
 *   **A check that claims to attribute a failure must observe BOTH SIDES of
 *   the change. A check that observes one side can report consistency, and
 *   never attribution.**
 *
 * Their case shows what the overclaim costs. Their post-swap gate rolled back on
 * a P0, saying it had ruled out a pre-existing cause; they measured the previous
 * build by hand and it failed the same way. A pre-existing P0 would have blocked
 * every deploy for ever while the gate announced it had checked.
 *
 * ── SO THERE ARE THREE ANSWERS, NOT TWO ──────────────────────────────────────
 *
 *   consistent    fails again on the same build. Blocks. Whose fault is still
 *                 unknown until the other side is observed.
 *   intermittent  passed on re-check. Does not block — a coin flip wired to a
 *                 rollback is the thing we are avoiding — and is REPORTED,
 *                 because a gate that goes quiet about what it could not
 *                 attribute is the gate nobody believes later.
 *   pre-existing  fails on the previous build too. Genuinely not this deploy's,
 *                 and the only one of the three that is an attribution.
 *
 * The third needs evidence from the other side of the swap, which — as they
 * point out — is only obtainable AFTER the rollback. So `onPrevious` is optional
 * and its absence is reported as unknown rather than assumed either way.
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
/**
 * @param {readonly import("./verdict.mjs").Cell[]} first
 * @param {readonly import("./verdict.mjs").Cell[]} retry       same build, once
 * @param {{onPrevious?: readonly import("./verdict.mjs").Cell[]}} [o]
 *   what the same checks did on the build being rolled back TO. Only available
 *   after the rollback, which is why it is separate and optional.
 */
export function attributedVerdict(first, retry, { onPrevious } = {}) {
  const blocking = verdictFor(first).blocking
  const retryByKey = new Map(retry.map((c) => [cellKey(c), c]))
  const prevByKey = onPrevious ? new Map(onPrevious.map((c) => [cellKey(c), c])) : null

  const owned = []
  const intermittent = []
  const preExisting = []
  for (const c of blocking) {
    const again = retryByKey.get(cellKey(c))
    // Absent from the retry → STILL FAILING, never passed: a retry that could
    // not run (wrong selector, layer error) must not be able to launder a red
    // into a green. That exact bug shipped once — a malformed selector made the
    // re-check exit 2 with no report, and this fallback was the only thing that
    // kept a bad build from being cleared.
    if (again && again.status === "pass") { intermittent.push(c); continue }

    // Consistent on this build. Now, and only now, the other side can say whose
    // it is — and only if somebody actually looked.
    const before = prevByKey?.get(cellKey(c))
    if (before && before.status !== "pass") { preExisting.push(c); continue }
    owned.push(c)
  }

  const verdict = verdictFor(owned)
  const parts = []
  if (intermittent.length) {
    parts.push(
      `${intermittent.length} cell(s) passed on re-check — INTERMITTENT on this build, reported anyway. ` +
      `This is not an attribution: the re-check ran on the same build, so it separates flaky from consistent and nothing else.`,
    )
  }
  if (preExisting.length) {
    parts.push(`${preExisting.length} cell(s) fail on the previous build too — pre-existing, not caused by this deploy`)
  }
  if (owned.length && !prevByKey) {
    parts.push(
      `${owned.length} cell(s) failed consistently and the previous build was not observed, so nothing here says the deploy ` +
      `caused them. A pre-existing failure looks exactly like this and would block every deploy for ever.`,
    )
  }

  return {
    ...verdict,
    owned,
    intermittent,
    preExisting,
    /**
     * Kept as an alias so existing callers do not silently start seeing an empty
     * list. It is the wrong word — these cells were never exonerated, only found
     * to be inconsistent — which is why the reason text no longer uses it.
     */
    exonerated: intermittent,
    attributed: Boolean(prevByKey),
    reason: [verdict.reason, ...parts].filter(Boolean).join(" · "),
  }
}
