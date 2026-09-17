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
/** Find the cell for an item by IDENTITY. The tests used `cells[0]`, which
 *  broke the day a liveness cell joined the list — a positional assertion fails
 *  for reasons that have nothing to do with the property it is pinning. */
const cellFor = (j, id = "page:/login-page") => j.cells.find((c) => c.feature === id)
const UP = { ok: true, status: 200 }
const DOWN = { ok: false, status: 503 }
const GONE = { ok: false, unreachable: "ECONNREFUSED" }

test("ORDERED AND NOT REPORTED IS NOT A PASS — and after a swap it is not a rollback either", () => {
  const j = orderVerdict({ order: ORDER, result: res([]) })
  assert.equal(j.covered, 0)
  assert.equal(j.ordered, 1)
  assert.equal(j.unverified, 1)
  assert.equal(cellFor(j).status, "blocked")
  assert.notEqual(cellFor(j).status, "pass")
  assert.match(cellFor(j).reason, /short green list must never read as full coverage/)
})

test("BLOCKED and NOT_EXERCISED do not roll back a good deploy — but are not a pass either", () => {
  // A peer's FIRST real run: /en/chat came back BLOCKED because the pipeline's
  // own sweep had rotated the test account's password. The deploy was fine, and
  // the step replaced it with the previous build because of a fixture.
  // "I could not see it" costs a different amount before and after the swap.
  for (const v of ["BLOCKED", "NOT_EXERCISED"]) {
    const j = orderVerdict({ order: ORDER, result: res([{ id: "page:/login-page", verdict: v }]) })
    assert.equal(cellFor(j).status, "blocked", `${v} must not roll back`)
    assert.notEqual(cellFor(j).status, "pass", `${v} must not read as a pass`)
    assert.equal(j.unverified, 1)
    assert.equal(j.verified, 0)
    assert.equal(verdictFor(j.cells).ship, true, "absence of evidence must not undo a deploy that passed everything measurable")
  }
})

test("before a swap, refusing is free again — `unmeasuredBlocks` restores it", () => {
  const j = orderVerdict({ order: ORDER, result: res([{ id: "page:/login-page", verdict: "BLOCKED" }]), unmeasuredBlocks: true })
  assert.equal(cellFor(j).status, "error")
  assert.equal(verdictFor(j.cells).ship, false)
})

test("a FAIL still rolls back — positive evidence is the thing that does", () => {
  const j = orderVerdict({ order: ORDER, result: res([{ id: "page:/login-page", verdict: "FAIL", why: "never mounted" }]) })
  assert.equal(cellFor(j).status, "fail")
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
  assert.equal(cellFor(loose).status, "pass")
  assert.equal(cellFor(loose).skillVerdict, "PASS_WITH_NOISE", "still recorded as its own state, not flattened")
  const strict = orderVerdict({ order: ORDER, result: res([{ id: "page:/login-page", verdict: "PASS_WITH_NOISE" }]), noiseIsFailure: true })
  assert.equal(cellFor(strict).status, "fail")
})

test("an unrecognised verdict is not a pass", () => {
  const j = orderVerdict({ order: ORDER, result: res([{ id: "page:/login-page", verdict: "probably fine" }]) })
  assert.notEqual(cellFor(j).status, "pass")
  assert.match(cellFor(j).reason, /unrecognised verdict/)
})

test("a clean report passes and carries its evidence", () => {
  const j = orderVerdict({ order: ORDER, result: res([{ id: "page:/login-page", verdict: "PASS", evidence: { errors: 0, shifts: 0 }, why: "mounted, no channel red" }]) })
  assert.equal(cellFor(j).status, "pass")
  assert.equal(j.covered, 1)
  assert.deepEqual(cellFor(j).evidence, { errors: 0, shifts: 0 })
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
  // A protocol failure blocks either way: a result that cannot be tied to this
  // deploy is indistinguishable from one fabricated for it, so unlike a
  // measurement failure it does NOT get the after-swap leniency.
  const j = orderVerdict({ order: ORDER, liveness: UP, result: { skill: "dom-test", artifactId: "stale", observed: [] } })
  assert.equal(j.cells.length, 1, "one cell, not one per ordered item")
  assert.equal(cellFor(j, "probe").priority, "P0")
  assert.equal(cellFor(j, "probe").status, "error")
  assert.equal(verdictFor(j.cells).ship, false)
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

/* ── the hole that yesterday's fix opened ─────────────────────────────── */

test("THE DANGEROUS CASE: the deploy took the site down, so the skill honestly said BLOCKED", () => {
  // Making BLOCKED non-blocking fixed a false red and opened a worse hole: a
  // deploy that breaks the site makes the skill report "I could not load the
  // page", which is the same word as an expired test password — and the two
  // need opposite handling. The discriminator is not in the reason text; it is
  // vibeUbi taking its own look.
  for (const live of [DOWN, GONE]) {
    const j = orderVerdict({ order: ORDER, liveness: live, result: res([{ id: "page:/login-page", verdict: "BLOCKED", why: "page never loaded" }]) })
    assert.equal(verdictFor(j.cells).ship, false, "the case that most needs a rollback must roll back")
    assert.ok(j.cells.some((c) => c.feature === "probe:liveness" && c.status === "fail"))
    assert.equal(j.cells.find((c) => c.feature === "page:/login-page").status, "fail")
  }
})

test("THE BENIGN CASE still ships: base is serving, the test side broke", () => {
  // The peer's actual first run: 200 from the site, their test account's
  // password rotated mid-run by the pipeline's own sweep.
  const j = orderVerdict({ order: ORDER, liveness: UP, result: res([{ id: "page:/login-page", verdict: "BLOCKED", why: "login timed out, credentials rotated" }]) })
  assert.equal(verdictFor(j.cells).ship, true)
  assert.equal(j.cells.find((c) => c.feature === "page:/login-page").status, "blocked")
  assert.equal(j.unverified, 1)
})

test("the same words, opposite outcomes — which is the whole point", () => {
  const same = [{ id: "page:/login-page", verdict: "BLOCKED", why: "could not see the page" }]
  const alive = orderVerdict({ order: ORDER, liveness: UP, result: res(same) })
  const dead = orderVerdict({ order: ORDER, liveness: DOWN, result: res(same) })
  assert.equal(verdictFor(alive.cells).ship, true)
  assert.equal(verdictFor(dead.cells).ship, false)
})

test("no look taken is NAMED, never assumed alive", () => {
  const j = orderVerdict({ order: ORDER, result: res([{ id: "page:/login-page", verdict: "PASS" }]) })
  const cell = j.cells.find((c) => c.feature === "probe:liveness")
  assert.ok(cell, "a judgement made without looking must say so")
  assert.equal(cell.status, "blocked")
  assert.match(cell.reason, /cannot be told from a failure of the deploy/)
})

test("the liveness cell is not counted as one of the ordered items", () => {
  const j = orderVerdict({ order: ORDER, liveness: UP, result: res([{ id: "page:/login-page", verdict: "PASS" }]) })
  assert.equal(j.ordered, 1)
  assert.equal(j.verified, 1)
  assert.equal(j.unverified, 0)
})

test("a site that is down does not turn a PASS into a fail — only absences", () => {
  // The skill saw the page and it was fine; a 503 on `/` afterwards is a real
  // problem and the liveness cell says so, but it must not rewrite an
  // observation that actually happened.
  const j = orderVerdict({ order: ORDER, liveness: DOWN, result: res([{ id: "page:/login-page", verdict: "PASS" }]) })
  assert.equal(j.cells.find((c) => c.feature === "page:/login-page").status, "pass")
  assert.equal(verdictFor(j.cells).ship, false, "but the base being down still blocks")
})
