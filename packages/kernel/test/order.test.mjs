/**
 * The probe step hands a SKILL the registry's P0 pages and judges what comes
 * back. Every test here is about a way a result can look complete and not be —
 * because a pluggable slot that accepts anything is a hole with a config key.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { probeOrder, orderVerdict, skillResultAdmission, SKILL_VERDICTS, FREE_INVARIANTS } from "../src/index.mjs"

const DISCOVERED = [
  { id: "page:/login-page", kind: "page" },
  { id: "page:/usage-page", kind: "page" },
  { id: "api:/api/metrics", kind: "api" },
]
const DECLARED = [
  { id: "page:/login-page", priority: "P0", testId: "app-page-login-page", probes: [{ expectVisible: "app-page-login-page" }] },
  { id: "page:/usage-page", priority: "P1", testId: "app-page-usage-page" },
]
const ORDER = probeOrder({ discovered: DISCOVERED, declared: DECLARED, artifactId: "abc-1", base: "http://x" })

test("the order comes from the registry, not from anyone's memory", () => {
  assert.equal(ORDER.items.length, 1, "only the P0 page by default")
  assert.equal(ORDER.items[0].id, "page:/login-page")
  assert.equal(ORDER.items[0].testId, "app-page-login-page")
  assert.equal(ORDER.skill, "dom-test", "the default skill")
  assert.ok(!ORDER.items.some((i) => i.id.startsWith("api:")), "pages only — an api route has no DOM")
})

test("every item carries the free invariants, so the step is worth turning on before anyone authors a probe", () => {
  assert.deepEqual(ORDER.items[0].invariants, FREE_INVARIANTS.map((i) => i.id))
  assert.ok(FREE_INVARIANTS.every((i) => i.why.length > 20), "each one names the bug it would have caught")
})

test("widening `only` picks up more, and that is the knob", () => {
  const wide = probeOrder({ discovered: DISCOVERED, declared: DECLARED, artifactId: "a", base: "b", only: ["P0", "P1"] })
  assert.equal(wide.items.length, 2)
})

/* ── admission: a result file is a REPORT ─────────────────────────────── */

test("a result produced against a different artifact is refused", () => {
  const r = skillResultAdmission({ order: ORDER, result: { skill: "dom-test", artifactId: "abc-0", observed: [] } })
  assert.equal(r.ok, false)
  assert.match(r.reason, /stale green file/)
})

test("a result with no artifact at all is refused", () => {
  const r = skillResultAdmission({ order: ORDER, result: { skill: "dom-test", observed: [] } })
  assert.equal(r.ok, false)
  assert.match(r.reason, /does not name an artifact/)
})

test("a result from a DIFFERENT skill is refused — a swapped slot must not answer quietly", () => {
  const r = skillResultAdmission({ order: ORDER, result: { skill: "some-other-skill", artifactId: "abc-1", observed: [] } })
  assert.equal(r.ok, false)
  assert.match(r.reason, /answering a different question/)
})

test("no result at all is refused, and says the two things that could mean", () => {
  const r = skillResultAdmission({ order: ORDER, result: null })
  assert.equal(r.ok, false)
  assert.match(r.reason, /did not run, or wrote somewhere else/)
})

/* ── judging ──────────────────────────────────────────────────────────── */
const res = (observed) => ({ skill: "dom-test", artifactId: "abc-1", observed })

test("ORDERED AND NOT REPORTED IS NOT A PASS — the load-bearing rule", () => {
  const j = orderVerdict({ order: ORDER, result: res([]) })
  assert.equal(j.covered, 0)
  assert.equal(j.ordered, 1)
  assert.equal(j.cells[0].status, "error")
  assert.equal(j.cells[0].priority, "P0", "so it blocks")
  assert.match(j.cells[0].reason, /short green list must never read as full coverage/)
})

test("BLOCKED and NOT_EXERCISED are `we do not know`, never a pass", () => {
  for (const v of ["BLOCKED", "NOT_EXERCISED"]) {
    const j = orderVerdict({ order: ORDER, result: res([{ id: "page:/login-page", verdict: v }]) })
    assert.equal(j.cells[0].status, "error", `${v} must not read as a pass`)
  }
})

test("PASS_WITH_NOISE fails by default, because the skill's own checklist says so", () => {
  // dom-test's table: "A channel going red on an item whose `ok` held is still
  // a FAIL of that item". Its scenario.js is looser. The two halves disagree;
  // this follows the stricter, and the knob exists so a project can differ ON
  // PURPOSE rather than by inheriting whichever half it happened to read.
  const strict = orderVerdict({ order: ORDER, result: res([{ id: "page:/login-page", verdict: "PASS_WITH_NOISE" }]) })
  assert.equal(strict.cells[0].status, "fail")
  const loose = orderVerdict({ order: ORDER, result: res([{ id: "page:/login-page", verdict: "PASS_WITH_NOISE" }]), noiseIsFailure: false })
  assert.equal(loose.cells[0].status, "pass")
})

test("an unrecognised verdict is not a pass", () => {
  const j = orderVerdict({ order: ORDER, result: res([{ id: "page:/login-page", verdict: "probably fine" }]) })
  assert.equal(j.cells[0].status, "error")
  assert.match(j.cells[0].reason, /unrecognised verdict/)
})

test("a clean report passes and carries its evidence", () => {
  const j = orderVerdict({ order: ORDER, result: res([{ id: "page:/login-page", verdict: "PASS", evidence: { errors: 0, shifts: 0 }, why: "mounted, no channel red" }]) })
  assert.equal(j.cells[0].status, "pass")
  assert.equal(j.covered, 1)
  assert.deepEqual(j.cells[0].evidence, { errors: 0, shifts: 0 })
})

test("what the skill checked WITHOUT being asked is kept — widening is the half it may do", () => {
  const j = orderVerdict({ order: ORDER, result: res([
    { id: "page:/login-page", verdict: "PASS" },
    { id: "page:/settings", verdict: "FAIL", why: "contrast 2.1 in dark theme" },
  ]) })
  const extra = j.cells.find((c) => c.feature === "page:/settings")
  assert.equal(extra.volunteered, true)
  assert.equal(extra.status, "fail")
  assert.equal(j.covered, 1, "volunteering does not count as covering the order")
})

test("an inadmissible result produces ONE P0 error, not a wall of them", () => {
  const j = orderVerdict({ order: ORDER, result: { skill: "dom-test", artifactId: "stale", observed: [] } })
  assert.equal(j.cells.length, 1)
  assert.equal(j.cells[0].priority, "P0")
  assert.equal(j.cells[0].status, "error")
})

test("the verdict vocabulary is the skill's own, so nothing needs translating", () => {
  assert.deepEqual([...SKILL_VERDICTS], ["PASS", "PASS_WITH_NOISE", "FAIL", "BLOCKED", "NOT_EXERCISED"])
})
