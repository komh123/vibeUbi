import { test } from "node:test"
import assert from "node:assert/strict"
import { diagnoseSummary, countsAsEvidence, DIAGNOSTIC_KIND, DIAGNOSTICS_DIR } from "../src/index.mjs"

test("a diagnostic lists every failure with a reason, not only the first", () => {
  const s = diagnoseSummary([
    { name: "lib", ok: false, code: 1 },
    { name: "ui", ok: true },
    { name: "engine", ok: false, timedOut: true },
    { name: "typecheck", ok: false, oom: "heap" },
    { name: "tests", ok: false, code: 0, reason: "# pass 0" },
  ])
  assert.equal(s.total, 5)
  assert.equal(s.passed, 1)
  assert.deepEqual(s.failed, [
    { name: "lib", why: "exited 1" },
    { name: "engine", why: "timed out" },
    { name: "typecheck", why: "ran out of heap" },
    { name: "tests", why: "# pass 0" },
  ])
  assert.equal(s.clean, false)
  assert.match(s.headline, /4 of 5/)
})

test("a clean diagnostic still says it is not evidence, and has no `ok` for a gate to read", () => {
  const s = diagnoseSummary([{ name: "a", ok: true }])
  assert.equal(s.clean, true)
  assert.equal(s.evidence, false)
  assert.equal("ok" in s, false)
  assert.match(s.headline, /not evidence/)
})

test("zero steps is not clean", () => {
  const s = diagnoseSummary([])
  assert.equal(s.clean, false)
  assert.match(s.headline, /proves nothing/)
})

test("countsAsEvidence refuses every diagnostic shape, even one that claims ok", () => {
  for (const r of [
    { kind: DIAGNOSTIC_KIND, ok: true },
    { diagnostic: true, ok: true },
    { evidence: false, ok: true },
    { ...diagnoseSummary([{ name: "a", ok: true }]), ok: true },
  ]) {
    const v = countsAsEvidence(r)
    assert.equal(v.ok, false)
    assert.match(v.reason, /diagnostic/)
  }
})

test("countsAsEvidence: narrowed, red, wrong phase and wrong tree are refused; a full green run is accepted", () => {
  assert.equal(countsAsEvidence(null).ok, false)
  assert.match(countsAsEvidence({ ok: true, narrowed: true }).reason, /narrowed/)
  assert.match(countsAsEvidence({ ok: false }).reason, /did not pass/)
  assert.match(countsAsEvidence({ ok: true, phase: "build" }, { phase: "verify" }).reason, /phase/)
  assert.match(countsAsEvidence({ ok: true, phase: "verify", sourceTree: "a" }, { phase: "verify", sourceTree: "b" }).reason, /different source tree/)
  assert.deepEqual(countsAsEvidence({ ok: true, phase: "verify", sourceTree: "a" }, { phase: "verify", sourceTree: "a" }), { ok: true })
})

test("diagnostics live outside the directory gates read", () => {
  assert.equal(DIAGNOSTICS_DIR.startsWith(".vibeubi/"), true)
  assert.notEqual(DIAGNOSTICS_DIR, ".vibeubi/runs")
  assert.equal(DIAGNOSTICS_DIR.includes("/runs"), false)
})
