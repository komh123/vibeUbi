import { test } from "node:test"
import assert from "node:assert/strict"
import { testPlan, readyToRun, planOutcome } from "../src/index.mjs"

test("testPlan: stable topological order — declaration order wherever the dependencies allow", () => {
  const p = testPlan([
    { id: "checkout", after: ["login", "cart"] },
    { id: "login" },
    { id: "search" },
    { id: "cart", after: ["login"] },
  ])
  assert.equal(p.ok, true)
  assert.deepEqual(p.order, ["login", "search", "cart", "checkout"])
})

test("testPlan: no dependencies at all keeps the declared order exactly", () => {
  const p = testPlan([{ id: "b" }, { id: "a" }, { id: "c" }])
  assert.deepEqual(p.order, ["b", "a", "c"])
})

test("testPlan: every problem in one pass — duplicate, unknown, self, cycle", () => {
  const p = testPlan([
    { id: "a", after: ["b"] },
    { id: "b", after: ["a"] },
    { id: "c", after: ["c"] },
    { id: "d", after: ["nope"] },
    { id: "d" },
    { id: "e", after: "a" },
  ])
  assert.equal(p.ok, false)
  const text = p.violations.join("\n")
  assert.match(text, /"d" is declared twice/)
  assert.match(text, /"d" .*unknown.*"nope"/)
  assert.match(text, /"c" depends on itself/)
  assert.match(text, /cycle.*a.*b/)
  assert.match(text, /"e".*`after` must be an array/)
})

test("readyToRun: only when every prerequisite PASSED — fail, blocked, not-run and absent all wait", () => {
  const item = { id: "x", after: ["a", "b"] }
  assert.equal(readyToRun({ id: "y" }, {}), true)
  assert.equal(readyToRun(item, { a: "pass", b: "pass" }), true)
  for (const b of ["fail", "blocked", "not-run", undefined]) {
    assert.equal(readyToRun(item, { a: "pass", ...(b ? { b } : {}) }), false, String(b))
  }
  assert.equal(readyToRun(item, { a: { status: "pass" }, b: { status: "pass" } }), true)
})

test("planOutcome: a red blocks only its dependents; blockedBy names the ROOT failure, not the direct parent", () => {
  const items = [
    { id: "login" },
    { id: "cart", after: ["login"] },
    { id: "checkout", after: ["cart"] },
    { id: "search" },
    { id: "profile", after: ["login"] },
  ]
  const o = planOutcome(items, { login: "fail", search: "pass" })
  const by = Object.fromEntries(o.items.map((i) => [i.id, i]))
  assert.equal(by.login.status, "fail")
  assert.equal(by.search.status, "pass", "an independent item is unaffected by a red elsewhere")
  assert.equal(by.cart.status, "blocked")
  assert.deepEqual(by.checkout.blockedBy, ["login"], "transitive: the root, not cart")
  assert.deepEqual(o.deferred.sort(), ["cart", "checkout", "profile"])
  assert.deepEqual(o.fixFirst, [{ id: "login", blocks: 3 }])
  assert.equal(o.clean, false)
  assert.match(o.headline, /1\/5 passed/)
  assert.match(o.headline, /3 blocked/)
  assert.match(o.headline, /fix first: login \(blocks 3\)/)
})

test("planOutcome: fixFirst is ordered by how much each failure blocks", () => {
  const items = [{ id: "a" }, { id: "b" }, { id: "a1", after: ["a"] }, { id: "b1", after: ["b"] }, { id: "b2", after: ["b"] }]
  const o = planOutcome(items, { a: "fail", b: { status: "fail", reason: "500" } })
  assert.deepEqual(o.fixFirst, [{ id: "b", blocks: 2 }, { id: "a", blocks: 1 }])
  assert.equal(o.items.find((i) => i.id === "b").reason, "500")
})

test("planOutcome: not-run is its own state — never pass, never fail — and blocks dependents", () => {
  const o = planOutcome([{ id: "a" }, { id: "b", after: ["a"] }, { id: "c" }], { a: { status: "not-run", reason: "budget" }, c: "pass" })
  const by = Object.fromEntries(o.items.map((i) => [i.id, i]))
  assert.equal(by.a.status, "not-run")
  assert.equal(by.b.status, "blocked")
  assert.deepEqual(by.b.blockedBy, ["a"])
  assert.deepEqual(o.fixFirst, [], "nothing FAILED; a not-run item is not a fix target")
  assert.equal(o.clean, false)
})

test("planOutcome: clean only when every item passed — an item with no result is not-run", () => {
  assert.equal(planOutcome([{ id: "a" }], { a: "pass" }).clean, true)
  const o = planOutcome([{ id: "a" }, { id: "b" }], { a: "pass" })
  assert.equal(o.clean, false)
  assert.equal(o.items[1].status, "not-run")
  assert.equal(planOutcome([], {}).clean, false, "zero items proves nothing")
})

import { acceptanceContract, acceptanceOrder } from "../src/index.mjs"

const accept = (items) => ({ phase: "post-swap", fulfil: () => ({}), items })

test("acceptanceContract: `after` is validated by the plan before anything runs", () => {
  assert.equal(acceptanceContract(accept([
    { id: "login", severity: "P0" }, { id: "cart", severity: "P1", after: ["login"] },
  ])).ok, true)
  const bad = acceptanceContract(accept([
    { id: "a", severity: "P0", after: ["b"] }, { id: "b", severity: "P0", after: ["a"] },
    { id: "c", severity: "P1", after: ["ghost"] },
  ]))
  assert.equal(bad.ok, false)
  assert.match(bad.reason, /cycle/)
  assert.match(bad.reason, /unknown item "ghost"/)
})

test("acceptanceOrder: items come out in plan order, so a prerequisite is never listed after its dependent", () => {
  const order = acceptanceOrder({ acceptance: accept([
    { id: "a-checkout", severity: "P0", after: ["z-login"] }, { id: "z-login", severity: "P1" },
  ]), artifactId: "x", base: "http://b" })
  assert.deepEqual(order.items.map((i) => i.id), ["z-login", "a-checkout"])
  assert.match(order.contract.why, /after/)
})
