/**
 * diagnose.mjs — `ubi diagnose`: every verify step, no stop at the first red, nothing mutated.
 *
 * The rule and its reason live in the kernel (`kernel/src/diagnose.mjs`). This is
 * only the mechanism: the same `runStep` the gate uses (same process-group kill,
 * same timeout, same heap fence, same "exit 0 is not tests ran" check), looped
 * without the `return` on red, and a report written where gates do not look.
 */
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { diagnoseSummary, testRanVerdict, DIAGNOSTICS_DIR } from "../../kernel/src/index.mjs"
import { runStep, BUDGET_MS } from "./run.mjs"

/**
 * @param {{ root: string, config: { verify?: { name: string, cmd: string, expectsTests?: boolean }[] },
 *           only?: string[] | null, emit?: (e: object) => void, now?: () => Date }} o
 */
export async function diagnose({ root, config, only = null, emit = () => {}, now = () => new Date() }) {
  const all = config.verify ?? []
  const unknown = (only ?? []).filter((n) => !all.some((c) => c.name === n))
  if (unknown.length) throw new Error(`unknown step(s): ${unknown.join(", ")}`)
  const checks = only ? all.filter((c) => only.includes(c.name)) : all

  const outDir = join(root, DIAGNOSTICS_DIR, now().toISOString().replaceAll(":", "-"))
  await mkdir(outDir, { recursive: true })

  const results = []
  for (const c of checks) {
    emit({ kind: "step", name: c.name, state: "run" })
    const [bin, ...args] = c.cmd.split(/\s+/)
    const r = await runStep(c.name, bin, args, { cwd: root, outDir, timeoutMs: BUDGET_MS.verify })
    let row = { name: c.name, code: r.code, ms: r.ms, timedOut: r.timedOut, oom: r.oom ?? null, ok: r.code === 0 && !r.timedOut }
    if (row.ok && c.expectsTests) {
      const ran = testRanVerdict(c.name, r.out)
      row = ran.ok ? { ...row, passed: ran.passed } : { ...row, ok: false, reason: ran.reason }
    }
    results.push(row)
    emit({ kind: "step", name: c.name, state: row.ok ? "pass" : "fail", row })
  }

  const report = { ...diagnoseSummary(results), narrowed: !!only, results, outDir }
  await writeFile(join(outDir, "report.json"), JSON.stringify(report, null, 2) + "\n")
  emit({ kind: "done", report })
  return report
}
