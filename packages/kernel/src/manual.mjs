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
 *   - the probe says it is CLOSED   Reported as done, with a prompt to delete the
 *                                   declaration. A stale gap is a standing claim
 *                                   that something is broken when it is not, and
 *                                   it teaches people to ignore the list.
 */

/** A manual gap must say who owns it and when it was accepted — a gap with no
 *  owner is everybody's, which means nobody's, and `debtAge` needs the date. */
export function manualGapAdmission(gap) {
  const faults = []
  if (!String(gap?.id ?? "").trim()) faults.push("no id")
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
export function manualGapVerdict({ gap, observed, now = Date.now() }) {
  const days = Number.isFinite(gap?.acceptedAt) ? Math.floor((now - gap.acceptedAt) / 86_400_000) : null
  const base = { id: gap?.id, owner: gap?.owner, days, runbook: gap?.runbook ?? null }

  if (observed === null || observed === undefined) {
    return {
      ...base, state: "unmeasured", blocks: true,
      reason: `the probe for "${gap?.id}" did not run, so nothing is known about it. An unrun probe contributes no finding, which reads exactly like a closed gap.`,
    }
  }
  if (observed.unreachable) {
    return {
      ...base, state: "unmeasured", blocks: true,
      reason: `could not observe "${gap?.id}": ${observed.unreachable}. Not evidence that it is fixed.`,
    }
  }
  if (observed.open) {
    return {
      ...base, state: "open", blocks: false,
      reason:
        `"${gap?.id}" is still open after ${days} day(s), owned by ${gap?.owner}. ` +
        (gap?.runbook ? `The fix is a human one: ${gap.runbook}. ` : "") +
        `It does not block — a gap a pipeline cannot close should not stop every deploy — but it is counted and dated so it cannot quietly become permanent.`,
    }
  }
  return {
    ...base, state: "closed", blocks: false,
    reason:
      `"${gap?.id}" is no longer present — it was fixed. Delete the declaration: a gap that is listed and not real ` +
      `is a standing claim that something is broken, and a list with those in it is a list people stop reading.`,
  }
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
