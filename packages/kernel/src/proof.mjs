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
 *   care which — only that the adapter went and looked.
 * @returns {DeployProof}
 */
export function deployProof({ expected, previous, observed }) {
  if (!expected) {
    return { ok: false, reason: "no artifact id was read from the new build — nothing to look for" }
  }
  if (typeof observed !== "string" || observed === "") {
    return { ok: false, reason: "nothing was observed from outside the deployment — the proof was never actually taken" }
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
