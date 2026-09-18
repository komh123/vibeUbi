/**
 * A fix only a human can perform still has an observable state. These tests
 * pin the three refusals that keep a runbook from becoming the record.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { manualGapAdmission, manualGapVerdict, manualGapReport, regressionVerdict } from "../src/index.mjs"

const DAY = 86_400_000
const GAP = {
  id: "filer-uid-map",
  why: "workspace files land root:root 0660 and the agent runs as uid 1000, so its shell tools cannot read them",
  owner: "platform",
  acceptedAt: Date.parse("2026-09-01"),
  runbook: "docs/runbooks/filer-uid-map.md",
  vantage: "e2e-modes",
  probe: () => ({ open: true }),
}

test("a gap with no probe is refused — that is the whole rule", () => {
  const { probe, ...noProbe } = GAP
  const r = manualGapAdmission(noProbe)
  assert.equal(r.ok, false)
  assert.match(r.reason, /a gap nobody can check is a comment/)
})

test("and no owner, no date, no reason are each refused", () => {
  for (const [field, pattern] of [["owner", /belongs to nobody/], ["acceptedAt", /how long this has stood/], ["why", /written why/]]) {
    const { [field]: _, ...missing } = GAP
    const r = manualGapAdmission(missing)
    assert.equal(r.ok, false, `missing ${field} should be refused`)
    assert.match(r.reason, pattern)
  }
})

test("a probeId is enough — the probe need not be a function here", () => {
  const { probe, ...byId } = GAP
  assert.equal(manualGapAdmission({ ...byId, probeId: "shell-can-read-workspace" }).ok, true)
})

test("still open: counted and dated, but it does NOT block", () => {
  const v = manualGapVerdict({ gap: GAP, observed: { open: true }, now: GAP.acceptedAt + 340 * DAY })
  assert.equal(v.state, "open")
  assert.equal(v.blocks, false, "a gap a pipeline cannot close must not stop every deploy")
  assert.equal(v.days, 340)
  assert.match(v.reason, /still open after 340 day\(s\), owned by platform/)
  assert.match(v.reason, /docs\/runbooks\/filer-uid-map\.md/)
})

test("could not look is NOT fixed, and it DOES block", () => {
  for (const observed of [null, undefined, { unreachable: "no ssh to the host" }]) {
    const v = manualGapVerdict({ gap: GAP, observed })
    assert.equal(v.state, "unmeasured")
    assert.equal(v.blocks, true,
      "collapsing `could not look` into `closed` is how a gap disappears while still being open")
  }
})

test("closed PROMOTES rather than deleting — the probe is the only reader", () => {
  // Deleting was the original design and a peer caught it on first use: their
  // gap had been closed for TEN DAYS and nobody knew, because the check that
  // would have said so had no caller. Deleting the declaration would have
  // recreated that vacuum in the other direction.
  const v = manualGapVerdict({ gap: GAP, observed: { open: false } })
  assert.equal(v.state, "closed")
  assert.equal(v.blocks, false)
  assert.equal(v.promoteTo, "regression")
  assert.match(v.reason, /do NOT delete it/)
  assert.doesNotMatch(v.reason, /^Delete/)
})

test("a gap is not judged from a run that cannot see it", () => {
  // The peer tried attaching theirs to the deploy pipeline, which has no live
  // sandbox: the probe would be unreachable, that blocks, and the third person
  // blocked deletes the check. Silence from the wrong place is not evidence and
  // is not a failure.
  const v = manualGapVerdict({ gap: GAP, observed: null, at: "ship" })
  assert.equal(v.state, "not-here")
  assert.equal(v.blocks, false)
  const here = manualGapVerdict({ gap: GAP, observed: null, at: "e2e-modes" })
  assert.equal(here.state, "unmeasured")
  assert.equal(here.blocks, true, "at the vantage that CAN see it, not looking is still a failure")
})

test("declaring a gap with no vantage is refused", () => {
  const { vantage, ...noVantage } = GAP
  const r = manualGapAdmission(noVantage)
  assert.equal(r.ok, false)
  assert.match(r.reason, /no vantage/)
})

/* ── a property that must not come back ───────────────────────────────── */
const GUARD = { id: "host-anonymous-filer", owner: "platform", closedAt: Date.parse("2026-09-07"), vantage: "e2e-modes" }

test("a regression BLOCKS, where an open gap does not", () => {
  const open = manualGapVerdict({ gap: GAP, observed: { open: true } })
  const regressed = regressionVerdict({ guard: GUARD, observed: { open: true }, now: GUARD.closedAt + 10 * DAY })
  assert.equal(open.blocks, false, "never fixed: the pipeline cannot close it, so it must not stop every deploy")
  assert.equal(regressed.blocks, true, "fixed and broke again: somebody undid a decision")
  assert.equal(regressed.state, "regressed")
  assert.match(regressed.reason, /was fixed 10 day\(s\) ago and is OPEN again/)
})

test("holding is quiet, and says how long it has held", () => {
  const v = regressionVerdict({ guard: GUARD, observed: { open: false }, now: GUARD.closedAt + 3 * DAY })
  assert.equal(v.state, "holding")
  assert.equal(v.blocks, false)
  assert.equal(v.days, 3)
})

test("not being able to confirm a regression guard BLOCKS — it was false once", () => {
  for (const observed of [null, undefined, { unreachable: "no live sandbox" }]) {
    const v = regressionVerdict({ guard: GUARD, observed })
    assert.equal(v.state, "unmeasured")
    assert.equal(v.blocks, true)
  }
  assert.equal(regressionVerdict({ guard: GUARD, observed: null, at: "ship" }).blocks, false,
    "but not from a run that was never able to see it")
})

test("the report separates the three, and names the oldest open one", () => {
  const now = GAP.acceptedAt + 100 * DAY
  const r = manualGapReport([
    manualGapVerdict({ gap: GAP, observed: { open: true }, now }),
    manualGapVerdict({ gap: { ...GAP, id: "b", acceptedAt: GAP.acceptedAt - 200 * DAY }, observed: { open: true }, now }),
    manualGapVerdict({ gap: { ...GAP, id: "c" }, observed: { open: false }, now }),
    manualGapVerdict({ gap: { ...GAP, id: "d" }, observed: null, now }),
  ])
  assert.deepEqual([r.open, r.closed, r.unmeasured], [2, 1, 1])
  assert.equal(r.blocks, true, "one unmeasured probe is enough to block")
  assert.equal(r.oldestDays, 300)
})

/* ── the seam: who decides what counts as an observation ──────────────── */
import { isObservation, observationAge } from "../src/index.mjs"

test("`observed` is NOT `state !== \"not-here\"` — that one line was the whole bug", () => {
  // A peer added a "last actually observed" timestamp — the right idea, and the
  // one I had asked them for — with the condition `if (state !== "not-here")`.
  // So `unmeasured` stamped too, and their report printed "could not measure"
  // and "last actually seen: today" on adjacent lines. "We tried and could not
  // see it" collapsed back into "we saw it", which is the single distinction
  // this module exists for.
  const g = { ...GAP }
  const cases = {
    "not-here":   manualGapVerdict({ gap: g, observed: null, at: "ship" }),
    unmeasured:   manualGapVerdict({ gap: g, observed: null, at: "e2e-modes" }),
    open:         manualGapVerdict({ gap: g, observed: { open: true } }),
    closed:       manualGapVerdict({ gap: g, observed: { open: false } }),
  }
  assert.equal(cases["not-here"].observed, false)
  assert.equal(cases.unmeasured.observed, false, "the naive derivation returns true here")
  assert.equal(cases.open.observed, true)
  assert.equal(cases.closed.observed, true)

  // and the naive predicate really does disagree, so this test is not vacuous
  const naive = (v) => v.state !== "not-here"
  assert.notEqual(naive(cases.unmeasured), cases.unmeasured.observed)
})

test("the regression guard carries it too, with the same rule", () => {
  const G = { id: "g", owner: "o", closedAt: Date.now(), vantage: "e2e-modes" }
  assert.equal(regressionVerdict({ guard: G, observed: { open: false } }).observed, true)
  assert.equal(regressionVerdict({ guard: G, observed: { open: true } }).observed, true)
  assert.equal(regressionVerdict({ guard: G, observed: null }).observed, false)
  assert.equal(regressionVerdict({ guard: G, observed: null, at: "ship" }).observed, false)
})

test("isObservation is the same rule, exported for anyone deriving their own", () => {
  for (const s of ["open", "closed", "holding", "regressed"]) assert.equal(isObservation(s), true)
  for (const s of ["not-here", "unmeasured", "", undefined]) assert.equal(isObservation(s), false)
})

test("legitimate silence is still silence — an aged-out guard says so", () => {
  const now = Date.parse("2026-09-17")
  assert.equal(observationAge({ lastObservedAt: now - 3 * DAY, now }).stale, false)
  const old = observationAge({ lastObservedAt: now - 90 * DAY, now })
  assert.equal(old.stale, true)
  assert.match(old.reason, /Every run since then was legitimately silent/)
})

test("never observed is stale, not zero days", () => {
  const never = observationAge({ lastObservedAt: null })
  assert.equal(never.days, null, "0 would read as `seen today`")
  assert.equal(never.stale, true)
  assert.match(never.reason, /guard in name only/)
})

/* ── vantage: "any" ───────────────────────────────────────────────────────── */

import { VANTAGE_ANY, observableFrom } from "../src/index.mjs"

const anyGap = {
  id: "no-web-search-provider", vantage: VANTAGE_ANY, why: "no provider configured",
  owner: "ops", acceptedAt: Date.now() - 86_400_000, probeId: "env-scan",
}

test('a probe that depends on nothing run-specific can say so, and is then observed anywhere', () => {
  // Before the sentinel, an exact comparison made this permanently `not-here`:
  // the probe ran, produced a real observation, and the verdict discarded it.
  for (const at of ["manual", "ci", "nightly", "whatever"]) {
    const v = manualGapVerdict({ gap: anyGap, observed: { open: true }, at })
    assert.notEqual(v.state, "not-here", `vantage "any" must be observable from ${at}`)
    assert.equal(v.state, "open")
  }
})

test('"any" is a sentinel, not a relaxed comparison — a typo is still scoped', () => {
  // The whole reason for a named constant: loosening the match would turn every
  // misspelling into a wildcard.
  const typo = { ...anyGap, vantage: "anywhere" }
  assert.equal(manualGapVerdict({ gap: typo, observed: { open: true }, at: "manual" }).state, "not-here")
  assert.equal(observableFrom("any", "manual"), true)
  assert.equal(observableFrom("sandbox", "manual"), false)
  assert.equal(observableFrom("sandbox", "sandbox"), true)
})

test('claiming "any" falsely makes the gate redder, not greener', () => {
  // The incentive that stops this being an escape hatch: a probe that needs a
  // live sandbox and declares "any" is now REACHED everywhere, and reports
  // unreachable where it cannot look — which is unmeasured, and blocks.
  const v = manualGapVerdict({ gap: anyGap, observed: { unreachable: "no sandbox here" }, at: "manual" })
  assert.equal(v.state, "unmeasured")
  assert.equal(v.blocks, true)
})

test("the refusal text tells a declarant the sentinel exists", () => {
  const r = manualGapAdmission({ ...anyGap, vantage: "" })
  assert.equal(r.ok, false)
  assert.match(r.reason, /vantage: "any"/)
})
