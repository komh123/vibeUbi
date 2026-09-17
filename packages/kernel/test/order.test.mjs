/**
 * The probe step hands a SKILL the registry's P0 pages and judges what comes
 * back. Every test here is about a way a result can look complete and not be —
 * because a pluggable slot that accepts anything is a hole with a config key.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { probeOrder, orderVerdict, skillResultAdmission, pageUrl, SKILL_VERDICTS, FREE_INVARIANTS, verdictFor } from "../src/index.mjs"

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

test("every item carries the free invariants WITH their reasons", () => {
  // The first version sent `.map(i => i.id)` and dropped `why` — which is the
  // field that lets an agent unfamiliar with the skill act without asking.
  assert.deepEqual(ORDER.items[0].invariants.map((i) => i.id), FREE_INVARIANTS.map((i) => i.id))
  assert.ok(ORDER.items[0].invariants.every((i) => i.why && i.why.length > 20), "the reason must survive the order")
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

test("ORDERED AND NOT REPORTED IS NOT A PASS — and after a swap it is not a rollback either", () => {
  const j = orderVerdict({ order: ORDER, result: res([]) })
  assert.equal(j.covered, 0)
  assert.equal(j.ordered, 1)
  assert.equal(j.unverified, 1)
  assert.equal(j.cells[0].status, "blocked")
  assert.notEqual(j.cells[0].status, "pass")
  assert.match(j.cells[0].reason, /short green list must never read as full coverage/)
})

test("BLOCKED and NOT_EXERCISED do not roll back a good deploy — but are not a pass either", () => {
  // A peer's FIRST real run: /en/chat came back BLOCKED because the pipeline's
  // own sweep had rotated the test account's password. The deploy was fine, and
  // the step replaced it with the previous build because of a fixture.
  // "I could not see it" costs a different amount before and after the swap.
  for (const v of ["BLOCKED", "NOT_EXERCISED"]) {
    const j = orderVerdict({ order: ORDER, result: res([{ id: "page:/login-page", verdict: v }]) })
    assert.equal(j.cells[0].status, "blocked", `${v} must not roll back`)
    assert.notEqual(j.cells[0].status, "pass", `${v} must not read as a pass`)
    assert.equal(j.unverified, 1)
    assert.equal(j.verified, 0)
    assert.equal(verdictFor(j.cells).ship, true, "absence of evidence must not undo a deploy that passed everything measurable")
  }
})

test("before a swap, refusing is free again — `unmeasuredBlocks` restores it", () => {
  const j = orderVerdict({ order: ORDER, result: res([{ id: "page:/login-page", verdict: "BLOCKED" }]), unmeasuredBlocks: true })
  assert.equal(j.cells[0].status, "error")
  assert.equal(verdictFor(j.cells).ship, false)
})

test("a FAIL still rolls back — positive evidence is the thing that does", () => {
  const j = orderVerdict({ order: ORDER, result: res([{ id: "page:/login-page", verdict: "FAIL", why: "never mounted" }]) })
  assert.equal(j.cells[0].status, "fail")
  assert.equal(verdictFor(j.cells).ship, false)
})

test("PASS_WITH_NOISE does not roll back by default — measured, not guessed", () => {
  // I defaulted to strict with no data, following dom-test's checklist table
  // over its scenario.js. The peer then measured: ~1 run in 4 on their app
  // produces net::ERR_NETWORK_CHANGED from an SSE stream cut by navigation —
  // noise nobody can act on. Strict-by-default would roll back a good deploy
  // about every fourth deploy. The real fix is the skill separating actionable
  // red from transport noise; until then this knob turns a skill's ambiguity
  // into a deploy decision, so it defaults off.
  const loose = orderVerdict({ order: ORDER, result: res([{ id: "page:/login-page", verdict: "PASS_WITH_NOISE" }]) })
  assert.equal(loose.cells[0].status, "pass")
  assert.equal(loose.cells[0].skillVerdict, "PASS_WITH_NOISE", "still recorded as its own state, not flattened")
  const strict = orderVerdict({ order: ORDER, result: res([{ id: "page:/login-page", verdict: "PASS_WITH_NOISE" }]), noiseIsFailure: true })
  assert.equal(strict.cells[0].status, "fail")
})

test("an unrecognised verdict is not a pass", () => {
  const j = orderVerdict({ order: ORDER, result: res([{ id: "page:/login-page", verdict: "probably fine" }]) })
  assert.notEqual(j.cells[0].status, "pass")
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

test("the order resolves the URL, because guessing it wrong means testing the wrong page and passing", () => {
  assert.equal(ORDER.items[0].url, "http://x/login-page")
  assert.equal(pageUrl("http://x/", "page:/a"), "http://x/a")
  assert.equal(pageUrl("http://x", "page:"), "http://x/")
  assert.equal(pageUrl("http://x", "page:b"), "http://x/b")
})

test("a DECLARED page discovery missed is in the order, named — not silently absent", () => {
  // Proven by the peer with a falsifiable pair: same declaration, one run with
  // the page discovered (1 item), one without (0 items), nothing else changed.
  // Scope narrowed before the filter, and the narrowing not said — so a run
  // with a broken discoverer orders fewer items and judges green on a smaller
  // universe.
  const blind = probeOrder({ discovered: [], declared: DECLARED, artifactId: "a", base: "http://x" })
  assert.equal(blind.items.length, 1, "the declared P0 must still be ordered")
  assert.equal(blind.items[0].discovered, false, "and the skill must be told which it is looking at")
  assert.equal(ORDER.items[0].discovered, true)
})
