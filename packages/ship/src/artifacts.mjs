/** Build/export and acquire a retention lease as one orchestration operation.
 * Adapters own storage (OCI archive, registry digest, running Docker hold, etc).
 * Retry only the build-success/artifact-disappeared race, never a failed build.
 * Leases outlive staging: release only after promotion or verified rollback.
 */
export async function buildRetained({ build, inspect, retain, missing, attempts = 2, emit = () => {} }) {
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 3) throw Error('Retention race retries must be bounded (1..3)')
  for (let attempt = 1; attempt <= attempts; attempt++) {
    await build()
    try {
      const artifact = await inspect()
      if (!artifact?.id) throw Error('Built artifact has no observed identity')
      const lease = await retain(artifact)
      if (lease?.artifactId !== artifact.id || !lease?.id) throw Error('Retention did not confirm the exact artifact identity')
      emit({ kind: 'artifact-retained', artifactId: artifact.id, lease: lease.id, attempt })
      return { artifact, lease, attempt }
    } catch (error) {
      if (attempt === attempts || missing?.(error) !== true) throw error
      emit({ kind: 'artifact-disappeared', attempt, reason: error.message })
    }
  }
}
