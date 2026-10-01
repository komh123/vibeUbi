/**
 * Acceptance is functional behaviour judged AFTER the swap — or, before it,
 * liveness and nothing else. Every test here is about a way an acceptance
 * declaration can look like a control and not be one: a phase that is not a
 * place, a severity that was defaulted, a "health" check that asserts a
 * feature, a retry that hides a flake.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import {
  acceptanceContract, preSwapBehaviourVerdict, acceptanceOrder, acceptanceVerdict,
  retryItems, foldAttempts, gateCells, verdictFor, orderVerdict, probeOrder,
  ACCEPTANCE_PHASES, ACCEPTANCE_SEVERITIES, HEALTH_BUDGET_MAX_MS,
} from "../src/index.mjs"

const fulfil = async () => ({})
const post = (over = {}) => ({
  phase: "post-swap", fulfil,
  items: [{ id: "acc:login", severity: "P0" }, { id: "acc:export", severity: "P1" }],
  ...over,
})
const health = (over = {}) => ({
  phase: "pre-swap-health", fulfil, healthOnly: true, timeBudgetMs: 30_000,
  items: [{ id: "health:login", severity: "P0", judges: "health" }],
  ...over,
})
const PROD = "https://app.example.com"

/* ── the contract ───────────────────────────────────────────────────────── */

test("the phase whitelist is exactly post-swap and pre-swap-health", () => {
  assert.deepEqual([...ACCEPTANCE_PHASES].sort(), ["post-swap", "pre-swap-health"])
  assert.deepEqual([...ACCEPTANCE_SEVERITIES], ["P0", "P1", "P2"])
  assert.equal(acceptanceContract(post()).ok, true)
  assert.equal(acceptanceContract(health()).ok, true)
})

test("any other phase is refused, and the reason names the two that exist", () => {
  for (const phase of ["pre-swap", "pre-build", "after-swap", "", undefined, "POST-SWAP", "post-swap "]) {
    const v = acceptanceContract(post({ phase }))
    assert.equal(v.ok, false, `phase ${JSON.stringify(phase)} must be refused`)
    assert.match(v.reason, /post-swap/)
    assert.match(v.reason, /pre-swap-health/)
  }
})

test("a missing severity is refused — not defaulted to P0, and not to P2", () => {
  for (const sev of [undefined, null, "", "p0", "critical", 0, "P3"]) {
    const v = acceptanceContract(post({ items: [{ id: "acc:x", severity: sev }] }))
    assert.equal(v.ok, false, `severity ${JSON.stringify(sev)} must be refused`)
    assert.match(v.reason, /acc:x/)
    assert.match(v.reason, /severity/)
  }
})

test("items must exist, be named, and be unique", () => {
  assert.equal(acceptanceContract(post({ items: [] })).ok, false)
  assert.equal(acceptanceContract(post({ items: undefined })).ok, false)
  assert.equal(acceptanceContract(post({ items: [{ severity: "P0" }] })).ok, false)
  const dup = acceptanceContract(post({ items: [{ id: "a", severity: "P0" }, { id: "a", severity: "P1" }] }))
  assert.equal(dup.ok, false)
  assert.match(dup.reason, /twice|duplicate/i)
})

test("an acceptance with nothing to run it is refused: fulfil is read, so it must exist", () => {
  const v = acceptanceContract(post({ fulfil: undefined }))
  assert.equal(v.ok, false)
  assert.match(v.reason, /fulfil/)
})

test("pre-swap-health must DECLARE healthOnly — silence is not the same as true", () => {
  const v = acceptanceContract(health({ healthOnly: undefined }))
  assert.equal(v.ok, false)
  assert.match(v.reason, /healthOnly/)
  // and "false" is a declaration the contract accepts and the behaviour rule judges
  assert.equal(acceptanceContract(health({ healthOnly: false })).ok, true)
})

test("pre-swap-health must carry a bounded time budget", () => {
  for (const timeBudgetMs of [undefined, 0, -1, NaN, Infinity, "30000", HEALTH_BUDGET_MAX_MS + 1]) {
    const v = acceptanceContract(health({ timeBudgetMs }))
    assert.equal(v.ok, false, `timeBudgetMs ${String(timeBudgetMs)} must be refused`)
    assert.match(v.reason, /timeBudgetMs/)
  }
  assert.equal(acceptanceContract(health({ timeBudgetMs: HEALTH_BUDGET_MAX_MS })).ok, true)
})

test("pre-swap-health items must say what they judge, explicitly", () => {
  const v = acceptanceContract(health({ items: [{ id: "h", severity: "P0" }] }))
  assert.equal(v.ok, false)
  assert.match(v.reason, /judges/)
  assert.equal(acceptanceContract(health({ items: [{ id: "h", severity: "P0", judges: "vibes" }] })).ok, false)
})

test("knobs that only mean something in one phase are refused in the other (declared but never read)", () => {
  assert.equal(acceptanceContract(post({ healthOnly: true })).ok, false)
  assert.equal(acceptanceContract(post({ staging: { base: "https://stg.example.com" } })).ok, false)
  assert.equal(acceptanceContract(post({ timeBudgetMs: 1000 })).ok, true, "a post-swap step may be bounded too")
})

test("attempts: integer 1..N, default 1, and only a P0 item has a rollback to protect", () => {
  assert.equal(acceptanceContract(post({ items: [{ id: "a", severity: "P0", attempts: 3 }] })).ok, true)
  for (const attempts of [0, -1, 1.5, "2", 99, NaN]) {
    assert.equal(acceptanceContract(post({ items: [{ id: "a", severity: "P0", attempts }] })).ok, false, `attempts ${String(attempts)}`)
  }
  const nonP0 = acceptanceContract(post({ items: [{ id: "a", severity: "P1", attempts: 2 }] }))
  assert.equal(nonP0.ok, false)
  assert.match(nonP0.reason, /P0/)
})

/* ── the pre-swap behaviour rule ────────────────────────────────────────── */

test("a project that declares nothing pre-swap-functional is untouched", () => {
  for (const d of [post(), health()]) {
    const v = preSwapBehaviourVerdict(d, { productionBase: PROD })
    assert.equal(v.refuse, false)
    assert.equal(v.warn, false)
  }
})

test("a pre-swap phase that is not health is refused, with the SKILL-STEP argument", () => {
  const v = preSwapBehaviourVerdict(post({ phase: "pre-swap" }), { productionBase: PROD })
  assert.equal(v.refuse, true)
  assert.equal(v.warn, false)
  assert.match(v.reason, /judges the build you are replacing/)
  assert.match(v.reason, /staging/)
})

test("pre-swap-health with healthOnly false is refused — and so is an unspoken one", () => {
  for (const healthOnly of [false, undefined]) {
    const v = preSwapBehaviourVerdict(health({ healthOnly }), { productionBase: PROD })
    assert.equal(v.refuse, true, `healthOnly ${String(healthOnly)}`)
    assert.match(v.reason, /judges the build you are replacing/)
  }
})

test("any item that judges behaviour in a pre-swap phase is refused, even under healthOnly: true", () => {
  // The flag is a claim; the item is the evidence. Where would the naive
  // predicate (`healthOnly === true` => fine) disagree? Exactly here.
  const d = health({ items: [{ id: "h1", severity: "P0", judges: "health" }, { id: "feature:export", severity: "P0", judges: "behaviour" }] })
  const v = preSwapBehaviourVerdict(d, { productionBase: PROD })
  assert.equal(v.refuse, true)
  assert.deepEqual(v.offending, ["feature:export"])
  assert.match(v.reason, /feature:export/)
})

test("a post-swap item that judges behaviour is exactly what post-swap is FOR", () => {
  const v = preSwapBehaviourVerdict(post({ items: [{ id: "a", severity: "P0", judges: "behaviour" }] }), { productionBase: PROD })
  assert.equal(v.refuse, false)
  assert.equal(v.warn, false)
})

test("the one exception: a separate staging instance — allowed, with a warning that is visible", () => {
  const d = health({ healthOnly: false, staging: { base: "https://staging.example.com" },
    items: [{ id: "feature:export", severity: "P0", judges: "behaviour" }] })
  const v = preSwapBehaviourVerdict(d, { productionBase: PROD })
  assert.equal(v.refuse, false)
  assert.equal(v.warn, true)
  assert.match(v.reason, /staging/)
  assert.match(v.reason, /build/i)
})

test("staging that IS production is not an exception (trailing slash and case do not make it different)", () => {
  for (const base of [PROD, `${PROD}/`, "HTTPS://APP.EXAMPLE.COM//"]) {
    const d = health({ healthOnly: false, staging: { base }, items: [{ id: "f", severity: "P0", judges: "behaviour" }] })
    const v = preSwapBehaviourVerdict(d, { productionBase: PROD })
    assert.equal(v.refuse, true, base)
    assert.match(v.reason, /production/)
    assert.equal(acceptanceContract(d, { productionBase: PROD }).ok, false, "and the contract names it too")
  }
})

test("staging cannot be compared with an unknown production base, so it is not granted", () => {
  // "we do not know" is a third answer; it must not read as "different".
  for (const productionBase of [undefined, null, ""]) {
    const d = health({ healthOnly: false, staging: { base: "https://staging.example.com" }, items: [{ id: "f", severity: "P0", judges: "behaviour" }] })
    assert.equal(preSwapBehaviourVerdict(d, { productionBase }).refuse, true)
  }
})

test("an empty or non-string staging base is not a staging instance", () => {
  for (const base of ["", "  ", undefined, 42]) {
    const d = health({ healthOnly: false, staging: { base }, items: [{ id: "f", severity: "P0", judges: "behaviour" }] })
    assert.equal(preSwapBehaviourVerdict(d, { productionBase: PROD }).refuse, true)
  }
})

/* ── the order and the one judge ────────────────────────────────────────── */

const ORDER = acceptanceOrder({ acceptance: post(), artifactId: "new-1", base: "http://x" })
const ok = (id, extra = {}) => ({ id, verdict: "PASS", ...extra })

test("the order has the probe order's shape — items carry severity as priority", () => {
  const p = probeOrder({ discovered: [], declared: [], artifactId: "new-1", base: "http://x" })
  for (const k of Object.keys(p)) assert.ok(k in ORDER, `order lacks "${k}", which the probe order has`)
  assert.equal(ORDER.at, "acceptance")
  assert.equal(ORDER.phase, "post-swap")
  assert.deepEqual(ORDER.items.map((i) => [i.id, i.priority]), [["acc:export", "P1"], ["acc:login", "P0"]].sort((a, b) => a[1].localeCompare(b[1])))
  assert.equal(ORDER.contract.itemsAreIndependent, true)
})

test("an item's own fields reach the skill (a path, a role) — and cannot overwrite its priority", () => {
  const o = acceptanceOrder({ acceptance: post({ items: [{ id: "a", severity: "P0", path: "/x", priority: "P2" }] }), artifactId: "n", base: "b" })
  assert.equal(o.items[0].path, "/x")
  assert.equal(o.items[0].priority, "P0", "severity is the declaration; a stray `priority` must not lower it")
})

const judgeCells = (result, extra = {}) => {
  const judged = acceptanceVerdict({ order: ORDER, result, liveness: { ok: true, status: 200, artifact: "new-1" }, ...extra })
  return { judged, verdict: verdictFor(gateCells({ cells: judged.cells, degraded: [] })) }
}
const res = (observed, extra = {}) => ({ skill: ORDER.skill, artifactId: "new-1", observedArtifact: "new-1", observed, ...extra })

test("cells use the probe's fields and vocabulary, under layer `acceptance`", () => {
  const { judged } = judgeCells(res([ok("acc:login"), ok("acc:export")]))
  for (const c of judged.cells) {
    assert.equal(c.layer, "acceptance")
    assert.ok(["pass", "fail", "error", "blocked"].includes(c.status))
    assert.ok(c.feature && c.priority)
  }
  assert.equal(judged.verified, 2)
})

test("a P0 failure is not shippable — it rolls back", () => {
  const { verdict, judged } = judgeCells(res([{ id: "acc:login", verdict: "FAIL", why: "no session" }, ok("acc:export")]))
  assert.equal(verdict.ship, false)
  assert.deepEqual(verdict.blocking.map((c) => c.feature), ["acc:login"])
  assert.match(judged.cells.find((c) => c.feature === "acc:login").reason, /no session/)
})

test("a P1/P2 failure ships, and is still a failing cell the report can print", () => {
  const { verdict, judged } = judgeCells(res([ok("acc:login"), { id: "acc:export", verdict: "FAIL", why: "csv empty" }]))
  assert.equal(verdict.ship, true)
  assert.match(verdict.reason, /non-P0 failure/)
  assert.equal(judged.cells.find((c) => c.feature === "acc:export").status, "fail")
})

test("an item the skill did not report is unverified — counted, not a rollback, post-swap", () => {
  const { verdict, judged } = judgeCells(res([ok("acc:login")]))
  assert.equal(verdict.ship, true)
  assert.equal(judged.unverified, 1)
  assert.match(verdict.reason, /BLOCKED/)
})

test("errors follow the probe's rules: no result at all is an error and blocks", () => {
  const judged = acceptanceVerdict({ order: ORDER, result: null, liveness: { ok: true, status: 200 } })
  const v = verdictFor(gateCells({ cells: judged.cells, degraded: [] }))
  assert.equal(v.ship, false)
  assert.equal(judged.cells[0].layer, "acceptance")
  assert.equal(judged.cells[0].status, "error")
})

test("a result about another build is refused, the same as for the probe", () => {
  const { verdict } = judgeCells(res([ok("acc:login"), ok("acc:export")], { artifactId: "yesterday" }))
  assert.equal(verdict.ship, false)
})

test("the site being down turns an unreported item into a failure — the same judge as the probe", () => {
  const judged = acceptanceVerdict({ order: ORDER, result: res([]), liveness: { ok: false, status: 503 } })
  const v = verdictFor(gateCells({ cells: judged.cells, degraded: [] }))
  assert.equal(v.ship, false)
})

test("it IS the probe's judge: one input, two layers, the same statuses", () => {
  const order = { ...ORDER, at: "probe" }
  const result = res([{ id: "acc:login", verdict: "FAIL" }, { id: "acc:export", verdict: "BLOCKED" }])
  const liveness = { ok: true, status: 200, artifact: "new-1" }
  const a = acceptanceVerdict({ order: ORDER, result, liveness }).cells.map((c) => [c.feature, c.status, c.priority])
  const p = orderVerdict({ order, result, liveness }).cells.map((c) => [c.feature, c.status, c.priority])
  assert.deepEqual(a, p)
})

test("before the swap an unmeasured item REFUSES (it is free), and the ties are not asserted about a build that does not exist yet", () => {
  const hOrder = acceptanceOrder({ acceptance: health(), artifactId: "old-0", base: "http://x" })
  const result = { skill: hOrder.skill, artifactId: "old-0", observedArtifact: "old-0", observed: [] }
  const judged = acceptanceVerdict({ order: hOrder, result, liveness: { ok: true, status: 200 }, phase: "pre-swap-health" })
  const v = verdictFor(gateCells({ cells: judged.cells, degraded: [] }))
  assert.equal(v.ship, false, "pre-swap, 'could not see' costs nothing, so it must not pass")
  const passed = acceptanceVerdict({ order: hOrder, result: { ...result, observed: [ok("health:login")] }, liveness: { ok: true, status: 200 }, phase: "pre-swap-health" })
  assert.equal(verdictFor(gateCells({ cells: passed.cells, degraded: [] })).ship, true)
})

/* ── attempts: retry a failed P0, never silently ────────────────────────── */

const ATT = acceptanceOrder({
  acceptance: post({ items: [{ id: "a", severity: "P0", attempts: 3 }, { id: "b", severity: "P0" }, { id: "c", severity: "P1", attempts: 3 }] }),   // c: the contract refuses this; the retry rule must not rely on that
  artifactId: "n", base: "b",
})
const cell = (feature, status, priority = "P0") => ({ feature, layer: "acceptance", priority, status, reason: `${feature} ${status}` })

test("only a FAILED P0 item with attempts left is retried", () => {
  const cells = [cell("a", "fail"), cell("b", "fail"), cell("c", "fail", "P1")]
  assert.deepEqual(retryItems({ order: ATT, cells, attemptsDone: 1 }), ["a"], "b has 1 attempt; c has attempts left but is not P0")
  assert.deepEqual(retryItems({ order: ATT, cells, attemptsDone: 3 }), [], "all of a's attempts are spent")
})

test("a blocked or errored item is not retried — a retry answers 'flaky?', not 'unmeasured'", () => {
  assert.deepEqual(retryItems({ order: ATT, cells: [cell("a", "blocked"), cell("b", "error")], attemptsDone: 1 }), [])
})

test("no retry while something other than an item is failing (liveness, admission)", () => {
  const cells = [cell("a", "fail"), { feature: "acceptance:liveness", layer: "acceptance", priority: "P0", status: "fail", reason: "down" }]
  assert.deepEqual(retryItems({ order: ATT, cells, attemptsDone: 1 }), [])
})

test("pass on retry is reported as FLAKY, never as a plain pass", () => {
  const { cells, flaky } = foldAttempts([[cell("a", "fail"), cell("b", "pass")], [cell("a", "pass")]])
  const a = cells.find((c) => c.feature === "a")
  assert.equal(a.status, "pass")
  assert.equal(a.flaky, true)
  assert.equal(a.attempts, 2)
  assert.match(a.reason, /attempt 2/)
  assert.match(a.reason, /a fail/, "the failure it hid is part of the record")
  assert.deepEqual(flaky.map((f) => f.feature), ["a"])
  assert.equal(cells.find((c) => c.feature === "b").flaky, undefined)
})

test("failing every attempt stays a failure and says how many were made", () => {
  const { cells, flaky } = foldAttempts([[cell("a", "fail")], [cell("a", "fail")], [cell("a", "fail")]])
  assert.equal(cells[0].status, "fail")
  assert.equal(cells[0].attempts, 3)
  assert.equal(flaky.length, 0)
  assert.equal(verdictFor(gateCells({ cells, degraded: [] })).ship, false)
})

test("a flaky pass does not hide in the verdict's reason either", () => {
  const { cells } = foldAttempts([[cell("a", "fail")], [cell("a", "pass")]])
  assert.ok(cells.every((c) => c.status === "pass"))
  assert.equal(cells[0].flaky, true, "the flag lives on the cell, which is what the report writes")
})
