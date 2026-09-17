/**
 * manual.mjs — gaps whose FIX only a human can perform.
 *
 * THE CASE THIS WAS BUILT FOR, from a peer session, because the general version
 * of it is unconvincing and the specific one is not:
 *
 *   Files written into a sandbox workspace land as `root:root 0660`, while the
 *   agent runs as uid 1000, so its shell tools cannot read them. The only fix is
 *   on the HOST — remount a filer with a uid map — and the mount point has live
 *   sandboxes bind-mounted under it, so it needs a lazy unmount and a remount.
 *   No pipeline may do that. It is a person, at a keyboard, at a chosen moment.
 *
 * So it went into a runbook. And a runbook is where a gap goes to be forgotten:
 * six months later nobody can tell whether it was done, and the only record is a
 * document that describes an intention.
 *
 * THE RULE HERE IS ONE LINE: a manual gap must carry a way to OBSERVE whether it
 * is still open, and that observation must be of the system, never of the
 * runbook. "Someone says they did it" is the same class of evidence as "the
 * deploy script exited 0", which this product exists to refuse.
 *
 * Three consequences fall out, and each is a refusal:
 *
 *   - declared with no probe        REFUSED. A gap nobody can check is a comment,
 *                                   and a comment in a gate is worse than nothing
 *                                   because it reads as coverage.
 *   - the probe cannot run          UNMEASURED, not "fine". Same treatment as any
 *                                   other check that did not run: it blocks, and
 *                                   the grade is withheld.
 *   - the probe says it is CLOSED   PROMOTED, not deleted. See below.
 *
 * DELETING A CLOSED GAP WAS WRONG, and the peer who first used this caught it
 * on their first run. The probe is usually the gap's ONLY reader, so deleting
 * the declaration deletes the reader — and the day the property regresses,
 * nobody finds out. That is not hypothetical: their gap had been CLOSED for ten
 * days and neither side knew, because the check that would have said so had no
 * caller. The same information vacuum, in the other direction.
 *
 * So a closed gap changes category rather than disappearing: from "somebody has
 * to go and do a thing" to "this must not go back". The severity inverts with
 * it — an OPEN gap does not block, because a pipeline should not stop every
 * deploy over something it cannot fix; a REGRESSED one does, because a safety
 * property that was fixed and then broke again is a different event from one
 * that was never fixed.
 *
 * WHERE THE READER LIVES IS PART OF THE DECLARATION. The same peer tried to
 * attach theirs to the deploy pipeline and stopped: the pipeline has no live
 * sandbox, so the probe would be `unreachable`, and "unreachable blocks" would
 * then block every deploy — and the third person to be blocked deletes the
 * check. A gate that is red from the first run is a gate that gets removed. So
 * a gap names the VANTAGE that can see it, and a run somewhere else reports
 * "not checked here" instead of a failure it has no standing to claim.
 */

/**
 * Did this verdict come from actually seeing the system?
 *
 * THE SEAM THIS CLOSES, found by the peer who uses this — in their own code,
 * one line, and it was the exact mistake the whole file exists to prevent.
 *
 * They added the thing I had warned them to add: a timestamp of the last REAL
 * observation, because `vantage` makes silence legitimate and legitimate
 * silence is still silence. Their condition was:
 *
 *     if (state !== "not-here") stamp()
 *
 * So `unmeasured` stamped too, and the report printed "could not measure" and
 * "last actually seen: today" side by side. "We tried and could not see it"
 * collapsed back into "we saw it" — which is the one distinction this module is
 * for.
 *
 * The kernel's states were right. The DERIVED fact was left to the caller, and
 * the obvious derivation is wrong. So it stops being the caller's: only a state
 * that carries a fact ABOUT THE SYSTEM counts as an observation. `not-here` and
 * `unmeasured` carry facts about the RUN.
 */
export function isObservation(state) {
  return state === "open" || state === "closed" || state === "holding" || state === "regressed"
}

/**
 * How long since anything actually looked — and is that too long?
 *
 * "We have a guard" and "the guard ran this month" are different claims, and a
 * vantage-scoped probe makes the second one easy to stop being true without
 * anyone noticing: every run that is not at the vantage reports `not-here`,
 * legitimately, forever.
 */
export function observationAge({ lastObservedAt, now = Date.now(), maxAgeDays = 30 }) {
  if (!Number.isFinite(lastObservedAt)) {
    return {
      days: null, stale: true,
      reason: "nothing has ever actually observed this. A guard that has never run is a guard in name only.",
    }
  }
  const days = Math.floor((now - lastObservedAt) / 86_400_000)
  return {
    days,
    stale: days > maxAgeDays,
    reason: days > maxAgeDays
      ? `last actually observed ${days} day(s) ago, past the ${maxAgeDays}-day limit. Every run since then was legitimately silent, which is not the same as fine.`
      : `last actually observed ${days} day(s) ago.`,
  }
}

/** A manual gap must say who owns it and when it was accepted — a gap with no
 *  owner is everybody's, which means nobody's, and `debtAge` needs the date. */
export function manualGapAdmission(gap) {
  const faults = []
  if (!String(gap?.id ?? "").trim()) faults.push("no id")
  if (!String(gap?.vantage ?? "").trim()) {
    faults.push(
      "no vantage — the run that can actually observe this must be named, or a run that cannot see it " +
      "reports `unreachable`, blocks, and gets deleted by the third person it stops",
    )
  }
  if (!String(gap?.why ?? "").trim()) faults.push("no reason — a gap with no written why cannot be judged later by anyone but its author")
  if (!String(gap?.owner ?? "").trim()) faults.push("no owner — a gap that belongs to everyone belongs to nobody")
  if (!Number.isFinite(gap?.acceptedAt)) faults.push("no date — without one nothing can say how long this has stood")
  if (typeof gap?.probe !== "function" && !gap?.probeId) {
    faults.push(
      "no probe. A manual fix still has an OBSERVABLE state, and a gap nobody can check is a comment — " +
      "which in a gate is worse than nothing, because it reads as coverage",
    )
  }
  if (gap?.runbook && !String(gap.runbook).trim()) faults.push("an empty runbook path")
  return faults.length === 0
    ? { ok: true }
    : { ok: false, reason: `this manual gap cannot be declared: ${faults.join("; ")}` }
}

/**
 * What does one observation mean?
 *
 * @param {object} o
 * @param {{id:string, why:string, owner:string, acceptedAt:number, runbook?:string}} o.gap
 * @param {{open:boolean}|{unreachable:string}|null} o.observed  what the probe
 *   saw. `null` and `{unreachable}` are NOT the same as `{open:false}` — the
 *   difference is the whole point, and collapsing them is how "we could not
 *   look" becomes "it is fixed".
 * @param {number} o.now
 */
export function manualGapVerdict({ gap, observed, at = null, now = Date.now() }) {
  const days = Number.isFinite(gap?.acceptedAt) ? Math.floor((now - gap.acceptedAt) / 86_400_000) : null
  const base = { id: gap?.id, owner: gap?.owner, days, runbook: gap?.runbook ?? null, vantage: gap?.vantage ?? null }

  // Silence from the wrong place is not evidence, and it is not a failure either.
  if (gap?.vantage && at && at !== gap.vantage) {
    return {
      ...base, state: "not-here", observed: false, blocks: false,
      reason: `"${gap?.id}" can only be observed from ${gap.vantage}; this run is ${at}, so nothing is claimed either way.`,
    }
  }

  if (observed === null || observed === undefined) {
    return {
      ...base, state: "unmeasured", observed: false, blocks: true,
      reason: `the probe for "${gap?.id}" did not run, so nothing is known about it. An unrun probe contributes no finding, which reads exactly like a closed gap.`,
    }
  }
  if (observed.unreachable) {
    return {
      ...base, state: "unmeasured", observed: false, blocks: true,
      reason: `could not observe "${gap?.id}": ${observed.unreachable}. Not evidence that it is fixed.`,
    }
  }
  if (observed.open) {
    return {
      ...base, state: "open", observed: true, blocks: false,
      reason:
        `"${gap?.id}" is still open after ${days} day(s), owned by ${gap?.owner}. ` +
        (gap?.runbook ? `The fix is a human one: ${gap.runbook}. ` : "") +
        `It does not block — a gap a pipeline cannot close should not stop every deploy — but it is counted and dated so it cannot quietly become permanent.`,
    }
  }
  return {
    ...base, state: "closed", observed: true, blocks: false,
    promoteTo: "regression",
    reason:
      `"${gap?.id}" is no longer present — it was fixed. Move it out of the open list, but do NOT delete it: ` +
      `this probe is usually the only thing watching that property, and deleting the declaration deletes the ` +
      `watcher. Promote it to a regression guard, where the same observation becomes "this must not come back".`,
  }
}

/**
 * A property that was fixed and must not come back.
 *
 * The severity is inverted from a manual gap on purpose. An open gap does not
 * block: the pipeline cannot close it and should not stop every deploy over it.
 * A REGRESSION blocks, because "it was fixed and broke again" is a different
 * event from "it was never fixed" — somebody's change undid a decision, and
 * nobody is going to notice from the fact that a list got one row shorter.
 *
 * `unmeasured` blocks too, and here that is not over-strict: this guard exists
 * because the property was once false, so "we could not check" has to be read
 * as "we do not know that it is still true".
 */
export function regressionVerdict({ guard, observed, at = null, now = Date.now() }) {
  const days = Number.isFinite(guard?.closedAt) ? Math.floor((now - guard.closedAt) / 86_400_000) : null
  const base = { id: guard?.id, owner: guard?.owner, days, vantage: guard?.vantage ?? null }

  if (guard?.vantage && at && at !== guard.vantage) {
    return { ...base, state: "not-here", observed: false, blocks: false, reason: `"${guard?.id}" is only observable from ${guard.vantage}; this run is ${at}.` }
  }
  if (observed === null || observed === undefined || observed?.unreachable) {
    return {
      ...base, state: "unmeasured", observed: false, blocks: true,
      reason:
        `could not confirm "${guard?.id}" is still closed${observed?.unreachable ? `: ${observed.unreachable}` : ""}. ` +
        `This property was false once, so not knowing is not the same as it being fine.`,
    }
  }
  if (observed.open) {
    return {
      ...base, state: "regressed", observed: true, blocks: true,
      reason:
        `"${guard?.id}" was fixed ${days} day(s) ago and is OPEN again. Something undid it, and the only reason ` +
        `anyone knows is that this probe outlived the gap it was written for.`,
    }
  }
  return { ...base, state: "holding", observed: true, blocks: false, reason: `"${guard?.id}" is still closed (${days} day(s)).` }
}

/** The whole set, so a report can say "3 open, 1 fixed, 1 we could not check". */
export function manualGapReport(verdicts) {
  const by = (s) => verdicts.filter((v) => v.state === s)
  const open = by("open")
  return {
    open: open.length,
    closed: by("closed").length,
    unmeasured: by("unmeasured").length,
    blocks: verdicts.some((v) => v.blocks),
    oldestDays: open.length ? Math.max(...open.map((v) => v.days ?? 0)) : null,
    verdicts,
  }
}
