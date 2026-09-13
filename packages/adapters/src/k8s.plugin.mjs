/**
 * vibeship-k8s — proof for a Kubernetes deployment.
 *
 * WHY THIS EXISTS SEPARATELY. On k8s the tempting proof is `kubectl rollout
 * status` returning 0. That is the exit code of the thing that did the
 * deploying, which is precisely the class of evidence the kernel refuses.
 *
 * The proof here is taken from INSIDE the running pod, about a file the new
 * image contains — plus the pod's age, so a pod that was never replaced cannot
 * masquerade as a new one.
 */
import { execFile } from "node:child_process"
import { promisify } from "node:util"
const run = promisify(execFile)

export const name = "vibeship-k8s"

export function apply(ctx, config = {}) {
  const { namespace, selector, container, marker } = config
  if (!namespace || !selector || !marker) return   // not configured → silent no-op

  ctx.target({
    proofClaim: {
      external: true,
      carriesArtifactId: true,
      source: "a hash computed inside the running pod, plus the pod's age",
    },
    async proof({ expected, previous }) {
      const { stdout: pods } = await run("kubectl", [
        "get", "pods", "-n", namespace, "-l", selector,
        "-o", "jsonpath={range .items[*]}{.metadata.name} {.status.startTime}{\"\\n\"}{end}",
      ])
      const rows = pods.trim().split("\n").filter(Boolean).map((l) => l.split(" "))
      if (rows.length === 0) return { expected, previous, observed: "" }

      const observed = []
      for (const [pod, startedAt] of rows) {
        const args = ["exec", "-n", namespace, pod]
        if (container) args.push("-c", container)
        args.push("--", "sha256sum", marker)
        try {
          const { stdout } = await run("kubectl", args)
          observed.push(`${pod} ${startedAt} ${stdout.trim()}`)
        } catch (err) {
          observed.push(`${pod} ${startedAt} UNREADABLE`)
        }
      }
      // Age is part of the evidence: an old pod serving the right hash means
      // the image tag moved under a pod that was never restarted.
      ctx.note(`pods observed: ${observed.length}`)
      return { expected, previous, observed: observed.join("\n") }
    },
  })
}
