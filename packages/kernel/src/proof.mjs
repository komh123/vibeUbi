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
