/**
 * A fix only a human can perform still has an observable state. These tests
 * pin the three refusals that keep a runbook from becoming the record.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { manualGapAdmission, manualGapVerdict, manualGapReport } from "../src/index.mjs"

const DAY = 86_400_000
const GAP = {
  id: "filer-uid-map",
  why: "workspace files land root:root 0660 and the agent runs as uid 1000, so its shell tools cannot read them",
  owner: "platform",
  acceptedAt: Date.parse("2026-09-01"),
  runbook: "docs/runbooks/filer-uid-map.md",
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

test("closed asks you to delete the declaration", () => {
  const v = manualGapVerdict({ gap: GAP, observed: { open: false } })
  assert.equal(v.state, "closed")
  assert.equal(v.blocks, false)
  assert.match(v.reason, /Delete the declaration/)
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
