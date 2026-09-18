/**
 * heap.mjs — how much heap one node sub-step may have, and what to say when it
 * runs out anyway.
 *
 * WHY THIS IS THE PIPELINE'S PROBLEM AND NOT A PROJECT'S.
 *
 * `ship` runs a project's type-check and unit suites as node sub-processes. On
 * a peer session's real project, measured rather than read from docs:
 *
 *     node's default old-space limit        4096 MB
 *     what v8.getHeapStatistics reports     4144 MB   (old-space + ~48)
 *     `tsc --noEmit` cold peak RSS          5318 MB   (3m52s, 0 type errors)
 *
 * The first two lines were one line saying 4144, and the difference is not
 * pedantry. Measured here across the flag:
 *
 *     (default)                 4144        --max-old-space-size=4096   4144
 *     --max-old-space-size=2048 2096        --max-old-space-size=4144   4192
 *
 * `heap_size_limit` runs ~48 MB above `max-old-space-size`, so the DEFAULT
 * old-space is 4096 — which means `--max-old-space-size=4096` is a no-op that
 * has always looked like a cap. Calling 4144 "the default old-space" invites
 * "then set 4097"; calling 4096 the default tells you the flag never did
 * anything. Same failure, and the description decides what someone does next.
 *
 * 5318 > 4144, so that step is a GUARANTEED out-of-memory, not a flake. Of the
 * fifteen node sub-steps in that pipeline, exactly zero had a heap ceiling, and
 * the one that did had it only because the project's own package.json set it.
 * Every project's peak crosses 4144 MB eventually, so a pipeline that spawns
 * node without a ceiling hands the same cliff to everyone who adopts it.
 *
 * WHAT IS MEASURED AND WHAT IS CHOSEN — stated because presenting a knob as
 * evidence is how a number stops being questioned:
 *
 *   measured  the 4144 MB default, the 5318 MB peak, and therefore the cliff
 *   CHOSEN    the 25% non-heap share and the [2048, 16384] MB clamp
 *
 * Nobody has the old-space-at-peak figure for that run, so the RSS-to-heap
 * ratio is not derivable from the evidence and 25% must not be dressed up as
 * if it were.
 *
 * THE ONE LOAD-BEARING PROPERTY is `heapMb < cgroupLimitMb`, strictly. If the
 * heap ceiling equals the cgroup limit, the cgroup kills the process first and
 * you get exit 137 — which is HARDER to read than V8's own message. Trading a
 * legible failure for an illegible one is not a fix.
 */

/** Chosen, not measured. Kept as named constants so they read as knobs. */
export const NON_HEAP_SHARE = 0.25
export const UNFENCED_SHARE = 0.75
export const HEAP_FLOOR_MB = 2048
export const HEAP_CEILING_MB = 16384

/**
 * @param {object} o  everything in MB — mixing GB and MB in one signature is
 *   how a `Math.floor` on gigabytes silently threw away up to 1 GB before the
 *   multiply in the first version of this.
 * @param {number|null} [o.cgroupLimitMb] the fence this step runs inside, if any
 * @param {number} [o.availableMb]        what the machine has free right now
 * @param {number} [o.reserveMb]          leave this much for everything else
 * @returns {{heapMb:number, fenced:boolean, reason:string, numbers:object, why:string, tooSmall?:boolean}}
 *   `reason` is a machine-readable code and `numbers` carries everything a
 *   sentence needs, because `why` is English prose and a consumer whose
 *   operator-facing strings are in another language must be able to render its
 *   own sentence without re-deriving the arithmetic. Proposed by the peer
 *   session that has the second implementation of this formula, whose tree is
 *   zh-TW throughout; a shared kernel should not own one language's words.
 */
export function nodeHeapMb({ cgroupLimitMb = null, availableMb = 0, reserveMb = 0 }) {
  const clamp = (n) => Math.max(HEAP_FLOOR_MB, Math.min(HEAP_CEILING_MB, Math.floor(n)))

  if (Number.isFinite(cgroupLimitMb) && cgroupLimitMb > 0) {
    /**
     * `reserveMb` is NOT applied here, deliberately.
     *
     * Whoever set the cgroup limit already took the machine's reserve out of
     * it — that subtraction is what setting a MemoryMax IS. Applying it again
     * double-counts, and on a small fence the double subtraction is the
     * difference between a step that runs and a step that cannot start.
     */
    const share = Math.floor(cgroupLimitMb * (1 - NON_HEAP_SHARE))
    const clamped = clamp(share)

    // The floor is not allowed to break the one load-bearing property.
    if (clamped >= cgroupLimitMb) {
      const under = Math.max(1, Math.floor(cgroupLimitMb * (1 - NON_HEAP_SHARE)))
      return {
        heapMb: under,
        fenced: true,
        tooSmall: true,
        reason: "fence-below-floor",
        numbers: { cgroupLimitMb, floorMb: HEAP_FLOOR_MB, derivedMb: under },
        why:
          `the fence is ${cgroupLimitMb} MB, which is below this pipeline's ${HEAP_FLOOR_MB} MB floor. ` +
          `Using ${under} MB because a heap at or above the fence gets the process cgroup-killed (exit 137) ` +
          `before V8 can say what happened — but this step may simply not fit here.`,
      }
    }
    return {
      heapMb: clamped,
      fenced: true,
      reason: "fenced",
      numbers: { cgroupLimitMb, nonHeapShare: NON_HEAP_SHARE, heapMb: clamped },
      why:
        `inside a ${cgroupLimitMb} MB fence; ${Math.round(NON_HEAP_SHARE * 100)}% left for everything that is not V8 heap. ` +
        `Kept strictly under the fence so an overrun is V8's legible message, not exit 137.`,
    }
  }

  const usable = Math.max(0, availableMb - reserveMb)
  return {
    heapMb: clamp(usable * UNFENCED_SHARE),
    fenced: false,
    reason: "unfenced",
    numbers: { availableMb, reserveMb, usableMb: usable, share: UNFENCED_SHARE, floorMb: HEAP_FLOOR_MB, ceilingMb: HEAP_CEILING_MB },
    why:
      `no fence; ${availableMb} MB available minus ${reserveMb} MB reserved, ` +
      `at ${Math.round(UNFENCED_SHARE * 100)}%, clamped to [${HEAP_FLOOR_MB}, ${HEAP_CEILING_MB}] MB. ` +
      `The floor stops a busy machine turning "the machine is busy" into "the project is broken"; ` +
      `the ceiling is there because V8 past ~16 GB mostly defers the real problem.`,
  }
}

/** V8's two ways of saying the same thing. A cgroup kill (137) is NOT this. */
const V8_OOM = /JavaScript heap out of memory|Ineffective mark-compacts near heap limit/

/**
 * Turn V8's OOM signature into something an operator can act on.
 *
 * Returns null when the output is not a V8 OOM, so the caller falls through to
 * its normal failure path — important, because a step can also die of a real
 * cgroup OOM and that needs a different message entirely.
 *
 * The self-lock sentence is the load-bearing one. Without it the operator
 * re-runs, sees an identical failure, and concludes the machine is broken —
 * which is exactly what happened, for two cycles, to the session that found this.
 */
/**
 * `forStep`, not `step`, on purpose.
 *
 * A peer consuming this kernel found that its own budget gate scans source for
 * `step: "X"` to list timed steps, and an option bag using that field name made
 * an unrelated call look like a timeout registration — the gate then went red
 * on correct behaviour, which is the kind of gate the next person deletes. A
 * shared kernel's option bags should avoid the common words (`step`, `name`,
 * `id`) that consumers' scanners key on. Cheap insurance.
 */
export function heapOomMessage({ output = "", forStep = "this step", heapMb, availableMb = 0 }) {
  if (!V8_OOM.test(String(output))) return null
  const availableGb = Math.floor(availableMb / 1024)
  return [
    `"${forStep}" hit V8's heap ceiling (this step was given ${heapMb} MB; the machine had ${availableGb} GB available). ` +
      `This is NOT the machine running out of memory — the ceiling it hit is node's own.`,
    `It also SELF-LOCKS: an incremental cache cannot be written during an OOM, so the next run is cold again and OOMs again.`,
    `Two ways out: (1) give this step more (see the fence share and nodeHeapMb), ` +
      `(2) make the type graph or test suite smaller (measure first: tsc --extendedDiagnostics, ` +
      `look at Files / Lines of Definitions / Lines of JSON).`,
    `Raising the ceiling is a tourniquet, not a fix: this number gets approached again as the codebase grows.`,
  ].join("\n")
}

/**
 * Should a step's process TREE be killed, rather than the child we hold?
 *
 * One decision, two mechanisms. The decision lives here so neither platform
 * branch can re-decide it; the mechanism belongs to whoever spawns.
 *
 * A peer session's version stops a systemd scope, which is correct for its
 * machine and would silently no-op on macOS and on CI containers with no
 * systemd — a fix that quietly does nothing on most users' machines is worse
 * than no fix, because it reports success.
 */
export function killScope(platform = process.platform) {
  return platform === "win32"
    ? { strategy: "taskkill", why: "Windows has no POSIX process groups; /T /F is what reaches the tree" }
    : { strategy: "process-group", why: "spawn detached, then kill the negative pid so the whole tree goes, not just the child we hold" }
}

/**
 * Is this ceiling doing anything, and is it doing HARM?
 *
 * The first version of this answered only `heapMb == default` and a peer
 * measured the band it missed. Theirs, with their fences:
 *
 *      8 GB available -> 1536 MB     14 GB -> 3840 MB     16 GB -> 4608 MB
 *
 * Mine, on this machine, with a 4096 MB default old-space:
 *
 *      6 GB available -> 3072 MB   LOWER than the default, and the predicate
 *                                  said nothing
 *
 * Equality is the harmless case: the flag did nothing. BELOW is the case that
 * inverts the feature — the pipeline LOWERS the ceiling while announcing it has
 * given the step N MB, so a user on a moderately loaded machine gets a feature
 * that makes an OOM MORE likely than not having it. A predicate that speaks
 * only at the single point where they are equal is silent across the whole
 * harmful range.
 *
 * `defaultOldSpaceMb` must be MEASURED by the caller, never hardcoded: V8 sizes
 * old-space from machine memory, so a constant 4096 would itself be exactly the
 * cap-shaped number this function exists to find.
 *
 * Not a refusal. A busy machine is a busy machine, not a broken one, and a
 * refusal there would be the too-wide kind that reads as "nothing to deploy".
 *
 * @returns {{effect:"raises"|"equals"|"lowers", ineffective:boolean, worse:boolean, heapMb:number, defaultOldSpaceMb:number}}
 */
export function ceilingEffect(heapMb, defaultOldSpaceMb, toleranceMb = 64) {
  if (!Number.isFinite(defaultOldSpaceMb) || defaultOldSpaceMb <= 0) {
    // Nothing measured, so claim nothing — the honest answer, not a cheerful one.
    return { effect: "raises", ineffective: false, worse: false, heapMb, defaultOldSpaceMb: 0 }
  }
  const delta = heapMb - defaultOldSpaceMb
  const effect = Math.abs(delta) <= toleranceMb ? "equals" : delta > 0 ? "raises" : "lowers"
  return {
    effect,
    ineffective: effect !== "raises",   // equals or lowers: the flag is not buying anything
    worse: effect === "lowers",         // and this half actively takes something away
    heapMb,
    defaultOldSpaceMb,
  }
}

/**
 * Why did that step stop making progress — and is that even knowable?
 *
 * A peer's ship printed this, verbatim, after killing a 40-minute build:
 *
 *     "build" did not finish within 40 minutes and was stopped.
 *     Load average is 6.41, so the machine was not busy — this looks like a hang.
 *     Run the step on its own and look for real I/O (a network call, a database,
 *     a container) in what it covers. Raising the limit is rarely the fix.
 *
 * **Every clause was wrong.** It was not a hang: the build was at 16.7 GB RSS
 * thrashing against 20 GB of swap. There was no real I/O to go and find. And the
 * one thing the message told them not to do — look at the limit — was where the
 * defect lived, because the binding limit under pressure was a 14 GB cache, not
 * the timeout. They spent the next hour looking for a network call.
 *
 * So the lesson is not "diagnose better", it is: **a confident wrong diagnosis
 * is strictly worse than silence**, because silence sends nobody anywhere. That
 * is why `unknown` is a first-class state here and its message carries no theory
 * at all. A tool that must say something will say something wrong.
 *
 * Load average is the wrong instrument in BOTH directions and is deliberately
 * not a discriminator: a thrashing process sits in D state and counts toward it,
 * and a genuinely hung one can sit at exactly the same number. What separates
 * them is memory pressure — swap GROWTH across the step, and RSS against the
 * ceiling. `loadAvg1` is accepted only so callers can pass what they have and be
 * told, explicitly, that it decided nothing.
 *
 * @param {object} o
 * @param {number} [o.quietForMs]          how long without progress
 * @param {number} [o.loadAvg1]            accepted, and never a discriminator
 * @param {number} [o.rssGb]               the step's resident set
 * @param {number} [o.swapUsedGb]          swap in use now
 * @param {number} [o.swapUsedGbAtStart]   swap in use when the step began
 * @param {number} [o.ceilingGb]           the memory wall the step runs under
 * @param {string} [o.step]
 */
export function hangVerdict({
  quietForMs, loadAvg1, rssGb, swapUsedGb, swapUsedGbAtStart, ceilingGb, step = "the step",
} = {}) {
  const num = (v) => (Number.isFinite(v) ? v : null)
  const rss = num(rssGb), ceil = num(ceilingGb)
  const swapNow = num(swapUsedGb), swapThen = num(swapUsedGbAtStart)
  const mins = Number.isFinite(quietForMs) ? Math.round(quietForMs / 60_000) : null
  const ranFor = mins == null ? "" : ` after ${mins} minute(s) without finishing`

  const swapGrowth = swapNow != null && swapThen != null ? swapNow - swapThen : null
  const headroom = rss != null && ceil != null && ceil > 0 ? rss / ceil : null

  /* ── the honest nothing ───────────────────────────────────────────────── */
  if (swapGrowth == null && headroom == null) {
    return {
      state: "unknown", known: false, swapGrowth, headroom, loadAvg1,
      // No theory. Not one word about hangs, I/O, or what to go and look for —
      // that sentence is the defect this function exists to stop.
      message:
        `${step} ran out of time${ranFor} and was stopped. ` +
        `Nothing here can say why: no swap or memory reading was supplied.` +
        (loadAvg1 != null
          ? ` Load average was ${loadAvg1}, which distinguishes nothing — a thrashing process and a hung one sit at the same number.`
          : ""),
    }
  }

  /* ── memory pressure, which is measurable ─────────────────────────────── */
  const thrashing = (swapGrowth != null && swapGrowth > 1) || (headroom != null && headroom >= 0.75)
  if (thrashing) {
    const facts = [
      swapGrowth != null ? `swap grew ${swapGrowth.toFixed(1)} GB during the step` : null,
      headroom != null ? `RSS reached ${rss.toFixed(1)} GB of a ${ceil.toFixed(1)} GB ceiling (${Math.round(headroom * 100)}%)` : null,
    ].filter(Boolean).join("; ")
    return {
      state: "thrashing", known: true, swapGrowth, headroom, loadAvg1,
      message:
        `${step} was stopped${ranFor}, and it was not idle: ${facts}. ` +
        `This is memory pressure, not a hang — the work was making progress through swap, slowly. ` +
        `Look at what this step is asked to hold, not at what it might be waiting on; the binding limit is ` +
        `whatever grew (a cache, a working set), and the timeout is the symptom.`,
    }
  }

  return {
    state: "quiet", known: true, swapGrowth, headroom, loadAvg1,
    message:
      `${step} was stopped${ranFor} with no memory pressure` +
      `${swapGrowth != null ? ` (swap moved ${swapGrowth.toFixed(1)} GB` : ""}` +
      `${headroom != null ? `${swapGrowth != null ? ", " : " ("}RSS ${Math.round(headroom * 100)}% of the ceiling` : ""}` +
      `${swapGrowth != null || headroom != null ? ")" : ""}. ` +
      `Memory has been ruled out; what it was waiting on has not been established.`,
  }
}
