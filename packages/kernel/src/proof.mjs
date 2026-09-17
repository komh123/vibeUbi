/**
 * proof.mjs — did the thing we just deployed actually start serving?
 *
 * THE ONE RULE THIS PRODUCT WILL NOT BEND:
 *
 *   1. The evidence must be obtained from OUTSIDE the process being deployed.
 *   2. The evidence must be able to CONTAIN the artifact id.
 *
 * Not the build's exit code. Not `systemctl restart` returning 0. Not an
 * HTTP 200. Not the pipeline's own report. A restart can succeed while the
 * swap did not, and then every signal except this one says the deploy worked.
 * That failure is what this file is named after.
 */

/** @typedef {{ok:true, artifactId:string} | {ok:false, reason:string}} DeployProof */

/**
 * @param {{expected:string, previous:string|null, observed:string}} input
 *   `observed` is whatever the adapter fetched from outside: a served page, a
 *   /version body, an image digest, an in-pod file hash. The kernel does not
 *   care which — only that the adapter went and looked. `unreachable`, when
 *   present, is why looking failed.
 * @returns {DeployProof}
 */
export function deployProof({ expected, previous, observed, unreachable }) {
  if (!expected) {
    return { ok: false, reason: "no artifact id was read from the new build — nothing to look for" }
  }
  if (typeof observed !== "string" || observed === "") {
    /**
     * "Nothing observed" has two causes that need different fixes, and saying
     * the wrong one sends the operator to the wrong place: the adapter never
     * looked, or it looked and the service was not there. `unreachable` is the
     * adapter reporting the second — keep its words.
     */
    return {
      ok: false,
      reason: unreachable
        ? `the service could not be reached from outside: ${unreachable}`
        : "nothing was observed from outside the deployment — the proof was never actually taken",
    }
  }
  /**
   * Same id on both sides: the check cannot fail, so it proves nothing.
   *
   * This is `vacuousComparison` in the shape it takes here. It happens for
   * real whenever the artifact id is the git commit and nothing was committed
   * between two deploys — the served page carries the expected id before the
   * swap as happily as after it, and a green tick appears for a swap that may
   * never have taken. Observed on the first end-to-end run of this pipeline.
   */
  if (previous && previous === expected) {
    return {
      ok: false,
      reason:
        `the new and previous artifacts have the same id (${expected}), so observing it proves nothing — ` +
        `the service would serve that id whether or not the swap took. Commit, or use an artifact id that changes per build.`,
    }
  }
  if (observed.includes(expected)) return { ok: true, artifactId: expected }
  if (previous && observed.includes(previous)) {
    return {
      ok: false,
      reason: `still serving the PREVIOUS build (${previous}). The process restarted; the swap did not take.`,
    }
  }
  return {
    ok: false,
    reason: `what was observed references neither the new build (${expected}) nor the previous one — is this the right host?`,
  }
}

/**
 * Is an adapter's proof step even capable of proving anything?
 *
 * Checked at wiring time, not at deploy time. An adapter whose `proof` reads a
 * local file, or reads the exit code of the command that did the deploying,
 * satisfies the type signature and proves nothing — and it is the ONE field an
 * AI can get wrong with nothing anywhere reporting an error.
 *
 * @param {{external:boolean, carriesArtifactId:boolean, source?:string}} claim
 */
export function proofContract(claim) {
  const faults = []
  if (!claim.external) faults.push("the evidence is read from inside the deployment itself")
  if (!claim.carriesArtifactId) faults.push("the evidence cannot carry the artifact id, so it cannot distinguish versions")
  if (faults.length === 0) return { ok: true }
  return {
    ok: false,
    reason: `this proof cannot prove a deploy: ${faults.join("; ")}${claim.source ? ` (${claim.source})` : ""}`,
  }
}

/**
 * Compare two INDEPENDENT observations — and refuse to call "both unreadable"
 * a match.
 *
 * THE RULE, in a peer's words, which generalise mine:
 *
 *     "unreadable" must have a representation that is not equal to any real
 *     value.
 *
 * `null` has one. The empty string does not — two empty strings compare equal,
 * so a field NEITHER side could read reports agreement. `0` does not. `false`
 * does not. Three defects across this week were the same thing at three
 * different type levels: `WEIGHT[severity] ?? 0` on a score, an empty-string
 * version field, and a `/version` endpoint answering `"unknown"`.
 *
 * Anywhere two sources are compared, the third answer has to exist: **same**,
 * **different**, and **we do not know**. Collapsing the third into either of
 * the first two is how a check that never ran reads as a check that passed.
 */
export function sameObserved(a, b, { what = "value" } = {}) {
  const read = (v) => (v === null || v === undefined || (typeof v === "string" && v.trim() === "") ? null : v)
  const x = read(a), y = read(b)
  if (x === null || y === null) {
    return {
      known: false, same: false,
      reason:
        `${what}: ${x === null && y === null ? "neither side could be read" : x === null ? "the first side could not be read" : "the second side could not be read"}, ` +
        `so nothing is known. Two unreadable values are not a match — they are two absences.`,
    }
  }
  return x === y
    ? { known: true, same: true, reason: `${what}: both sides read ${String(x).slice(0, 80)}` }
    : { known: true, same: false, reason: `${what}: ${String(x).slice(0, 80)} vs ${String(y).slice(0, 80)}` }
}
