/**
 * discrimination.mjs — does this proof actually TELL BUILDS APART?
 *
 * `proofContract` asks whether a proof CAN carry an artifact id. That is a
 * question about shape, and a peer handed me the payload that shows why shape
 * is not enough — one endpoint, one contract, two fields:
 *
 *     { "commit": null, "buildId": "KGnc5zIqM6jlQ6phpKEz2", … }
 *
 * `commit` comes from a CI variable in a deployment that does not use CI, so it
 * is null on every build, for ever. `buildId` identifies the artifact. Both sit
 * behind the same `versionPath`, so a check on the SHAPE says "yes, this can
 * carry an id" — and that yes is true of exactly one of them.
 *
 * Their reframing is the fix: **do not check the proof's shape, check its
 * discriminating power.** That needs no trust in the adapter and is not
 * circular, because it is not asking the proof about itself. It asks for
 * something the pipeline already collects — what this endpoint said on the
 * LAST deploy — and compares.
 *
 * TWO DIRECTIONS, and the second is the one I would not have thought of.
 *
 *   1 · on a SWAP, the value must CHANGE.
 *       Otherwise it is `commit: null` — the same answer for every build, which
 *       is the same answer as no answer.
 *
 *   2 · on a ROLLBACK to an artifact seen before, it must return to the value
 *       it had then.
 *       This is the trap direction. `loadedAt` changes on every deploy, so it
 *       passes (1) — and a rollback restarts the process, giving it a NEW
 *       timestamp for the OLD artifact. The field says "a different deploy"
 *       while the same build came back. It identifies process start, not
 *       artifact, and only direction (2) can see that.
 *
 * Measured across three real deploys of one app:
 *
 *     buildId   bpXmD_3uCBKysribpDArg → KGnc5zIqM6jlQ6phpKEz2   changed   ok
 *     commit    null                  → null                    unchanged no power
 *     version   "0.1.0"               → "0.1.0"                 unchanged no power
 *     loadedAt  06:56:44Z             → 08:38:38Z               changed   wrong thing
 */

/**
 * @typedef {{artifactId:string, observed:string|null, at:number}} ProofSample
 *   One (artifact, what the proof said) pair, recorded per deploy. `observed`
 *   is null when nothing could be read — never "" (see `sameObserved`).
 */

/**
 * @param {readonly ProofSample[]} samples  oldest first
 * @param {{minArtifacts?:number}} [o]
 */
export function proofDiscrimination(samples = [], { minArtifacts = 2 } = {}) {
  const usable = samples.filter((s) => s && s.artifactId && s.observed != null && String(s.observed).trim() !== "")
  const artifacts = new Set(usable.map((s) => s.artifactId))

  if (artifacts.size < minArtifacts) {
    // Not a pass. Nothing has been established yet, and saying "ok" here is how
    // a proof with no power sails through its first N deploys.
    return {
      known: false, ok: false, verdict: "unmeasured",
      reason:
        `only ${artifacts.size} distinct artifact(s) have been observed, so nothing is known about whether this proof ` +
        `can tell builds apart. It needs ${minArtifacts} before the question can be asked.`,
    }
  }

  /* ── direction 1: different artifacts must produce different values ──── */
  const byValue = new Map()
  for (const s of usable) {
    const k = String(s.observed)
    byValue.set(k, (byValue.get(k) ?? new Set()).add(s.artifactId))
  }
  const collisions = [...byValue.entries()].filter(([, ids]) => ids.size > 1)
  if (collisions.length) {
    const [value, ids] = collisions[0]
    return {
      known: true, ok: false, verdict: "no-power",
      reason:
        `this proof answered ${JSON.stringify(String(value).slice(0, 60))} for ${ids.size} different artifacts ` +
        `(${[...ids].slice(0, 3).join(", ")}). The same answer for every build is the same answer as no answer — ` +
        `a green tick from this proof means nothing about which build is running.`,
    }
  }

  /* ── direction 2: the SAME artifact must produce the same value ──────── */
  const byArtifact = new Map()
  for (const s of usable) {
    byArtifact.set(s.artifactId, (byArtifact.get(s.artifactId) ?? new Set()).add(String(s.observed)))
  }
  const drifting = [...byArtifact.entries()].filter(([, vals]) => vals.size > 1)
  if (drifting.length) {
    const [artifact, vals] = drifting[0]
    return {
      known: true, ok: false, verdict: "identifies-something-else",
      reason:
        `artifact ${artifact} was observed as ${[...vals].slice(0, 2).map((v) => JSON.stringify(String(v).slice(0, 40))).join(" and ")} ` +
        `at different times. A value that changes while the artifact does not is identifying something else — process start, ` +
        `a clock, a request id. It passes a "did it change on deploy" check and still cannot recognise a rollback.`,
    }
  }

  return {
    known: true, ok: true, verdict: "discriminating",
    reason: `${artifacts.size} artifacts, ${byValue.size} distinct values, one-to-one — this proof tells builds apart.`,
  }
}

/**
 * Keep the history bounded, and keep the ROLLBACK evidence.
 *
 * A plain "last N" window loses the older sample of an artifact that comes
 * back, which is the only sample direction 2 can use — so the trim keeps the
 * first and last sighting of every artifact and drops the middle.
 */
export function trimProofHistory(samples = [], max = 40) {
  if (samples.length <= max) return [...samples]

  const first = new Map(), last = new Map()
  for (const s of samples) {
    if (!first.has(s.artifactId)) first.set(s.artifactId, s)
    last.set(s.artifactId, s)
  }
  const keep = new Set([...first.values(), ...last.values()])
  const kept = samples.filter((s) => keep.has(s))
  if (kept.length <= max) return kept

  /**
   * Still over budget, so something has to go — and it must not be the oldest.
   *
   * The first version finished with `kept.slice(-max)`, which drops the EARLIEST
   * entries, i.e. exactly the first sighting of a returning artifact. That is
   * the only sample direction 2 can use, so the fallback undid the whole reason
   * the function exists. Caught by the test that asserts a drift is still
   * detectable AFTER trimming — an assertion about what survives, rather than
   * about how many did.
   *
   * So: artifacts seen more than once are the rollback evidence and are kept
   * whole. Only single-sighting artifacts are dropped, oldest first, because
   * one sighting can prove no-power but never drift.
   */
  const seenTwice = [...last.keys()].filter((id) => first.get(id) !== last.get(id))
  const evidence = kept.filter((s) => seenTwice.includes(s.artifactId))
  const singles = kept.filter((s) => !seenTwice.includes(s.artifactId))
  const room = Math.max(0, max - evidence.length)
  return [...evidence, ...singles.slice(-room)].sort((a, b) => (a.at ?? 0) - (b.at ?? 0))
}
