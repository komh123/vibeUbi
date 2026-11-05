/**
 * test-plan.mjs — run everything, then fix: a plan with dependencies, where a red
 * blocks only what depends on it.
 *
 * ## Why this exists
 *
 * An acceptance that is one long sequence stops at its first red, so every run
 * shows one problem and the items after it are never seen. Measured on one
 * deploy: rounds 15–20 each failed at a different item, and every one of those
 * items had been passing or unreached — the run could not tell "broken" from
 * "never got there". Most items do not depend on each other at all; the few that
 * do should say so, and only those should wait.
 *
 * So the plan is written BEFORE anything runs: every item, and for each one the
 * items it needs (`after`). Then:
 *
 *   · an item runs when every item it is `after` has PASSED (`readyToRun`)
 *   · a red blocks its dependents — transitively — and nothing else
 *   · a blocked item is DEFERRED to the next round, and says which root failure
 *     it is waiting on (`blockedBy`), so the fix list is the failures, not the noise
 *
 * `after` is a precondition, not shared state. An item still gets its own
 * session; "checkout after login" means "a checkout result is only meaningful if
 * login works", not "checkout reuses login's cookies".
 *
 * Zero I/O. The ship side does the running.
 */

/** Statuses an item can end in. `not-run` is never pass and never fail. */
export const PLAN_STATUSES = Object.freeze(["pass", "fail", "blocked", "not-run"])

/**
 * Statuses a consumer may opt into (`planOutcome(items, results, { skipped: true })`).
 * Kept apart from `PLAN_STATUSES` so nothing that enumerated the defaults sees a
 * new member it never asked for.
 *
 * `skipped`: the item could not run because of the ENVIRONMENT (a permission the
 * owner has not fixed, a site that is not provisioned), not because of the change.
 * It is not a pass, it is not a failure to fix, it blocks its dependents like any
 * red does, and it can never be evidence (`countsAsEvidence` refuses it).
 */
export const OPTIONAL_PLAN_STATUSES = Object.freeze(["skipped"])

const statusOf = (r) => (r === undefined || r === null ? undefined : typeof r === "string" ? r : r.status)
const categoryOf = (r) => (r && typeof r === "object" && typeof r.category === "string" && r.category ? r.category : undefined)
const reasonOf = (r) => (r && typeof r === "object" && typeof r.reason === "string" ? r.reason : undefined)
const afterOf = (it) => (Array.isArray(it?.after) ? it.after : [])

/**
 * Validate the plan and order it.
 *
 * Every problem is reported in one pass — a plan refused one fault at a time is
 * the same one-red-per-run loop this exists to end.
 *
 * @param {readonly {id: string, after?: readonly string[], severity?: string}[]} items
 * @returns {{ok: true, order: string[]} | {ok: false, violations: string[]}}
 */
export function testPlan(items) {
  const list = Array.isArray(items) ? items : []
  const violations = []
  const ids = []
  const seen = new Set()
  for (const [i, it] of list.entries()) {
    const id = it && typeof it.id === "string" && it.id.trim() ? it.id : null
    if (!id) { violations.push(`item #${i} has no id`); continue }
    if (seen.has(id)) violations.push(`item "${id}" is declared twice — a result row could be about either`)
    else ids.push(id)
    seen.add(id)
    if (it.after !== undefined && !Array.isArray(it.after)) {
      violations.push(`item "${id}": \`after\` must be an array of item ids, got ${JSON.stringify(it.after)}`)
    }
  }
  const known = new Set(ids)
  const deps = new Map()
  for (const it of list) {
    if (!it || typeof it.id !== "string" || deps.has(it.id)) continue
    const own = afterOf(it)
    for (const d of own) {
      if (d === it.id) violations.push(`item "${it.id}" depends on itself`)
      else if (!known.has(d)) violations.push(`item "${it.id}" is after an unknown item "${d}"`)
    }
    deps.set(it.id, own.filter((d) => d !== it.id && known.has(d)))
  }

  // Kahn's algorithm, always taking the earliest-declared ready item: the order a
  // reader expects, changed only where a dependency forces it.
  const indexOf = new Map(ids.map((id, i) => [id, i]))
  const remaining = new Map(ids.map((id) => [id, new Set(deps.get(id) ?? [])]))
  const order = []
  while (remaining.size) {
    const ready = [...remaining].filter(([, d]) => d.size === 0).map(([id]) => id)
    if (ready.length === 0) {
      const cyc = [...remaining.keys()].sort((a, b) => indexOf.get(a) - indexOf.get(b))
      violations.push(`dependency cycle among ${cyc.map((c) => `"${c}"`).join(", ")} — none of them can ever run`)
      break
    }
    const next = ready.sort((a, b) => indexOf.get(a) - indexOf.get(b))[0]
    order.push(next)
    remaining.delete(next)
    for (const d of remaining.values()) d.delete(next)
  }
  return violations.length ? { ok: false, violations } : { ok: true, order }
}

/**
 * May this item run now? Only when every prerequisite PASSED. A prerequisite that
 * failed, is blocked, was not run or has no result yet all mean "not yet".
 *
 * @param {{after?: readonly string[]}} item
 * @param {Record<string, string | {status: string}>} statuses
 */
export function readyToRun(item, statuses = {}) {
  return afterOf(item).every((d) => statusOf(statuses[d]) === "pass")
}

/**
 * What the round came to — the report and the fix list.
 *
 * An item with a result keeps it. An item without one is `blocked` when some
 * prerequisite (transitively) did not pass, with `blockedBy` naming the ROOT
 * causes — the failed or not-run items at the top of the chain, not the direct
 * parent, so the fix list points at what to fix. Otherwise it is `not-run`.
 *
 * @param {readonly {id: string, after?: readonly string[], severity?: string}[]} items
 * `{ skipped: true }` opts into the `skipped` status (see OPTIONAL_PLAN_STATUSES). Without it
 * every result is read exactly as it always was, including a result that says `skipped`.
 *
 * @param {Record<string, "pass" | "fail" | "not-run" | {status: string, reason?: string, category?: string}>} results
 * @param {{skipped?: boolean}} [options]
 */
export function planOutcome(items, results = {}, { skipped: allowSkipped = false } = {}) {
  const list = (Array.isArray(items) ? items : []).filter((it) => it && typeof it.id === "string")
  const byId = new Map(list.map((it) => [it.id, it]))
  const memo = new Map()

  /** @returns {{status: string, roots: string[]}} */
  const resolve = (id, trail = new Set()) => {
    if (memo.has(id)) return memo.get(id)
    const own = statusOf(results[id])
    let out
    if (own === "pass" || own === "fail" || own === "not-run" || (allowSkipped && own === "skipped")) out = { status: own, roots: own === "pass" ? [] : [id] }
    else if (trail.has(id)) out = { status: "not-run", roots: [id] }
    else {
      trail.add(id)
      const roots = new Set()
      for (const d of afterOf(byId.get(id))) {
        if (!byId.has(d)) continue
        const r = resolve(d, trail)
        if (r.status !== "pass") for (const x of r.roots) roots.add(x)
      }
      out = roots.size ? { status: "blocked", roots: [...roots] } : { status: "not-run", roots: [id] }
    }
    memo.set(id, out)
    return out
  }

  const rows = list.map((it) => {
    const r = resolve(it.id)
    return {
      id: it.id,
      ...(it.severity ? { severity: it.severity } : {}),
      status: r.status,
      ...(r.status === "blocked" ? { blockedBy: r.roots } : {}),
      ...(r.status === "skipped" && categoryOf(results[it.id]) ? { category: categoryOf(results[it.id]) } : {}),
      ...(reasonOf(results[it.id]) ? { reason: reasonOf(results[it.id]) } : {}),
    }
  })
  const blocks = new Map()
  for (const row of rows) for (const root of row.blockedBy ?? []) blocks.set(root, (blocks.get(root) ?? 0) + 1)
  const order = new Map(rows.map((r, i) => [r.id, i]))
  const fixFirst = rows.filter((r) => r.status === "fail")
    .map((r) => ({ id: r.id, blocks: blocks.get(r.id) ?? 0 }))
    .sort((a, b) => b.blocks - a.blocks || order.get(a.id) - order.get(b.id))
  const count = (s) => rows.filter((r) => r.status === s).length
  const passed = count("pass"), failed = count("fail"), blocked = count("blocked"), notRun = count("not-run"), skipped = count("skipped")
  const clean = rows.length > 0 && passed === rows.length
  const headline = rows.length === 0
    ? "nothing was planned — an empty plan proves nothing"
    : `${passed}/${rows.length} passed` +
      (failed ? ` · ${failed} failed` : "") +
      (blocked ? ` · ${blocked} blocked (deferred to the next round)` : "") +
      (notRun ? ` · ${notRun} not run` : "") +
      (skipped ? ` · ${skipped} skipped (environment, not the change)` : "") +
      (fixFirst.length ? ` — fix first: ${fixFirst.map((f) => `${f.id} (blocks ${f.blocks})`).join(", ")}` : "")
  return {
    items: rows, fixFirst, deferred: rows.filter((r) => r.status === "blocked").map((r) => r.id), clean, headline,
    // Present only when something was skipped, so an outcome without a skip keeps its old shape.
    ...(skipped ? { skipped: rows.filter((r) => r.status === "skipped").map((r) => r.id) } : {}),
  }
}
