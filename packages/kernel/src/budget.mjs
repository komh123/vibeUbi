/**
 * budget.mjs — a timeout table only guards what it is ATTACHED to.
 *
 * Contributed by the session that runs this pipeline daily, and it is the
 * orphan rule wearing different clothes:
 *
 *     a step the runner puts a clock on, with no declared budget,
 *     silently receives the default — and stops being covered by the rule.
 *
 * The observed failure: a new step (`unit: release checks`) was added to the
 * runner without an entry in the budget table. It kept running, kept printing
 * a green tick, and quietly sat under a 15-minute default that the ≥6×/≤40×
 * rule never touched. A 28-second step would hang for fifteen minutes before
 * anyone was told, and every symptom reads as "the pipeline is a bit slow
 * today". The same gap had already bitten once on a different step.
 *
 * So the table needs the SAME two-way check a registry does:
 *   clocked but not budgeted  →  ORPHAN (it gets the default in silence)
 *   budgeted but not clocked  →  STALE  (a rename left the entry guarding air)
 *
 * Plus the budget rule itself, which exists so that a budget is neither so
 * tight it flakes nor so loose it stops being a limit at all.
 */

export const MIN_BUDGET_MS = 5 * 60_000
export const MIN_FACTOR = 6
export const MAX_FACTOR = 40

/**
 * @param {{clocked: readonly string[], budgets: Record<string, number>, observed: Record<string, number>, defaultMs: number}} input
 *   `clocked`  — every step name the RUNNER actually times (read from the
 *                runner, never re-typed; re-typing is how the names drift apart)
 *   `budgets`  — the declared limits
 *   `observed` — the worst time each step has really taken
 */
export function budgetVerdict({ clocked, budgets, observed, defaultMs = 15 * 60_000 }) {
  const faults = []

  for (const step of clocked) {
    if (!(step in budgets)) {
      faults.push({
        kind: "orphan", step,
        why: `the runner times "${step}" and no budget is declared for it — it silently gets the ${Math.round(defaultMs / 60_000)} minute default, and the budget rule never sees it`,
      })
    }
  }

  const clockedSet = new Set(clocked)
  for (const step of Object.keys(budgets)) {
    if (!clockedSet.has(step)) {
      faults.push({
        kind: "stale", step,
        why: `a budget is declared for "${step}" but the runner never times it — a rename left this entry guarding nothing while still passing its own test`,
      })
    }
  }

  for (const [step, budget] of Object.entries(budgets)) {
    const worst = observed[step]
    if (worst === undefined) {
      faults.push({
        kind: "unmeasured", step,
        why: `"${step}" has a budget checked against no measurement — the number is a guess wearing a rule's clothes`,
      })
      continue
    }
    if (budget < MIN_BUDGET_MS) {
      faults.push({ kind: "too-tight", step, why: `${ms(budget)} is under the ${ms(MIN_BUDGET_MS)} floor — a budget that flakes teaches people to re-run` })
    } else if (budget < worst * MIN_FACTOR) {
      faults.push({ kind: "too-tight", step, why: `${ms(budget)} is under ${MIN_FACTOR}× the worst observed ${ms(worst)}` })
    } else if (budget > worst * MAX_FACTOR) {
      faults.push({ kind: "too-loose", step, why: `${ms(budget)} is over ${MAX_FACTOR}× the worst observed ${ms(worst)} — at that size it is not a limit, it is a default` })
    }
  }

  return { ok: faults.length === 0, faults, reason: faults.length === 0 ? `${clocked.length} step(s) budgeted and measured` : faults.map((f) => f.why).join(" · ") }
}

const ms = (n) => (n >= 60_000 ? `${Math.round(n / 60_000)}m` : `${Math.round(n / 1000)}s`)

/**
 * Is this check capable of failing at all?
 *
 * The generalisation of `deployProof`'s first rule — *the evidence must come
 * from somewhere other than the thing being checked* — applied to any
 * comparison.
 *
 * The observed failure: a test passed `undefined` explicitly to a parameter
 * whose default is `process.env.AGENT_RUNTIME`. The default therefore fired,
 * both sides of the comparison resolved to the same source, and the assertion
 * could not fail. It measured what the machine happened to be set to, and
 * reported it as a passing test.
 *
 * Green, forever, proving nothing — which is the exact shape `testRanVerdict`
 * exists for, one level deeper: there, no test ran; here, a test ran and was
 * vacuous.
 */
export function vacuousComparison({ leftSource, rightSource, note = "" }) {
  if (!leftSource || !rightSource) return { ok: true }
  if (leftSource !== rightSource) return { ok: true }
  return {
    ok: false,
    reason:
      `both sides of this comparison resolve to ${leftSource}, so it cannot fail. ` +
      `It measures the environment, not the code${note ? ` (${note})` : ""}. ` +
      `Passing \`undefined\` explicitly to a parameter WITH a default fires the default — ` +
      `the argument you thought you were injecting never arrives.`,
  }
}
