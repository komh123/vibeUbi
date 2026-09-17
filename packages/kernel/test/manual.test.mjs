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
