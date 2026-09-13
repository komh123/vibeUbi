/**
 * Decisions contributed by the session that runs this pipeline every day
 * (ubuntu-67, 2026-09-13). Each one is a real defect it hit and fixed; these
 * tests are the kernel-level generalisation of each.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import {
  budgetVerdict, vacuousComparison, MIN_BUDGET_MS,
  baselineAdmission, exemptionScope, checkAssertsOnBehaviour, sourceScanHit, textRuleFitness,
} from "../src/index.mjs"

const MIN = 60_000

/* ── budgets: the orphan rule, applied to a timeout table ──────────────── */

test("a step the runner clocks with no declared budget is an ORPHAN", () => {
  // The real one: a new step was added to the runner with no budget entry. It
  // kept printing a green tick under a silent 15-minute default while the
  // ≥6×/≤40× rule never saw it.
  const v = budgetVerdict({
    clocked: ["tsc", "unit: release checks"],
    budgets: { "tsc": 10 * MIN },
    observed: { "tsc": 30_000 },
  })
  assert.equal(v.ok, false)
  assert.equal(v.faults[0].kind, "orphan")
  assert.match(v.faults[0].why, /silently gets the 15 minute default/)
})

test("a budget for a step nobody clocks is STALE — a rename left it guarding air", () => {
  const v = budgetVerdict({
    clocked: ["unit: sweep tests"],
    budgets: { "unit: sweep": 10 * MIN, "unit: sweep tests": 10 * MIN },
    observed: { "unit: sweep": 34_000, "unit: sweep tests": 34_000 },
  })
  assert.ok(v.faults.some((f) => f.kind === "stale" && f.step === "unit: sweep"))
})

test("a budget checked against no measurement is a guess wearing a rule's clothes", () => {
  const v = budgetVerdict({ clocked: ["x"], budgets: { x: 10 * MIN }, observed: {} })
  assert.ok(v.faults.some((f) => f.kind === "unmeasured"))
})

test("too tight flakes, too loose stops being a limit", () => {
  const tight = budgetVerdict({ clocked: ["x"], budgets: { x: 2 * MIN }, observed: { x: 60_000 } })
  assert.ok(tight.faults.some((f) => f.kind === "too-tight"))
  const loose = budgetVerdict({ clocked: ["x"], budgets: { x: 60 * MIN }, observed: { x: 60_000 } })
  assert.ok(loose.faults.some((f) => f.kind === "too-loose"))
  const ok = budgetVerdict({ clocked: ["x"], budgets: { x: 10 * MIN }, observed: { x: 60_000 } })
  assert.equal(ok.ok, true)
})

test("the floor holds even for a step that always runs fast", () => {
  const v = budgetVerdict({ clocked: ["x"], budgets: { x: MIN_BUDGET_MS - 1 }, observed: { x: 1000 } })
  assert.ok(v.faults.some((f) => f.kind === "too-tight"))
})

/* ── vacuous comparisons: a test that ran, and proved nothing ──────────── */

test("both sides from the same source cannot fail", () => {
  // The real one: `undefined` passed explicitly to a parameter whose default
  // is process.env.X. The default fired, both sides read the same env var, and
  // the assertion measured the machine instead of the code.
  const v = vacuousComparison({ leftSource: "process.env.AGENT_RUNTIME", rightSource: "process.env.AGENT_RUNTIME" })
  assert.equal(v.ok, false)
  assert.match(v.reason, /fires the default/)
})

test("independent sources are fine", () => {
  assert.equal(vacuousComparison({ leftSource: "fixture", rightSource: "process.env.X" }).ok, true)
})

/* ── admission: a false positive must never become a baseline entry ────── */

test("a false positive may NOT be written into the baseline", () => {
  // The real one: a coverage checker did not recognise a third invocation
  // shape and reported two RUNNING test files as unrun. Baselining them would
  // have formally declared that nobody runs them.
  const v = baselineAdmission({ fingerprint: "a", severity: "high", verdict: "false-positive", reason: "checker misses this shape" })
  assert.equal(v.admit, false)
  assert.match(v.reason, /fixed in the RULE/)
})

test("correct behaviour may NOT be written into the baseline either", () => {
  assert.equal(baselineAdmission({ fingerprint: "a", severity: "high", verdict: "correct-behaviour", reason: "the 404 is right" }).admit, false)
})

test("real debt may be accepted — but only with a written reason", () => {
  assert.equal(baselineAdmission({ fingerprint: "a", severity: "high", reason: "vendor fix lands in Q4" }).admit, true)
  assert.equal(baselineAdmission({ fingerprint: "a", severity: "high", reason: "  " }).admit, false)
})

/* ── exemptions must be narrow ─────────────────────────────────────────── */

test("an exemption for correct behaviour must name the one thing, not the surface", () => {
  // The real one: a layer went red three ships running on a 404 that was the
  // correct answer; two retries passed and were filed as flake, the third
  // rolled back a good build. The fix named ONE file.
  const wide = exemptionScope({ target: "/api/file*", reason: "user has no @kit", observed: "404" })
  assert.equal(wide.ok, false)
  assert.match(wide.reason, /wildcard/)

  const narrow = exemptionScope({ target: "slides/_components/index.tsx", reason: "the user never wrote @kit; 404 is the correct answer", observed: "GET 404" })
  assert.equal(narrow.ok, true)
})

test("an exemption with no reason or no observed behaviour is refused", () => {
  assert.equal(exemptionScope({ target: "a/b.tsx", reason: "", observed: "404" }).ok, false)
  assert.equal(exemptionScope({ target: "a/b.tsx", reason: "because" }).ok, false)
})

/* ── checks must assert on behaviour, not on how a file looks ──────────── */

test("a check that only reads source text goes red on a rename and green on a gutting", () => {
  // The real one: three gate assertions compared a script's source. Upstream
  // shrank it 187 → 29 lines and moved the capability; the gate failed on
  // spelling while the behaviour was fine.
  const v = checkAssertsOnBehaviour({ reads: "scripts/check-deployed.mjs", calls: false })
  assert.equal(v.ok, false)
  assert.match(v.reason, /make the subject injectable and call it/)
  assert.equal(checkAssertsOnBehaviour({ reads: null, calls: true }).ok, true)
})

/* ── text rules that match the wrong thing ─────────────────────────────── */

test("a regex that matched its own comment is a false positive, not a finding", () => {
  // Hit three times in one day by the same session: a gate comparing source
  // text, a regex matching its OWN comment, a regex matching parameter types.
  const r = sourceScanHit({ pattern: "TODO", matchedIn: "comment" })
  assert.equal(r.real, false)
  assert.match(r.reason, /reading the explanation of the thing instead of the thing/)
})

test("a match in a type annotation is erased before anything runs", () => {
  assert.equal(sourceScanHit({ matchedIn: "type-annotation" }).real, false)
})

test("a rule matching itself is the purest form of the bug", () => {
  assert.match(sourceScanHit({ matchedIn: "own-source" }).reason, /matched ITSELF/)
})

test("a match in real code is real", () => {
  assert.equal(sourceScanHit({ matchedIn: "call-expression" }).real, true)
})

test("the fix is a lexer — never an allow-list, never the baseline", () => {
  const r = sourceScanHit({ matchedIn: "string-literal" })
  assert.match(r.reason, /never with an allow-list/)
  assert.match(r.reason, /never by baselining it/)
  // and the two rules agree with each other:
  assert.equal(baselineAdmission({ fingerprint: "x", severity: "high", verdict: "false-positive", reason: "regex hit a comment" }).admit, false)
})

test("a low-precision text rule may not gate anything", () => {
  // Measured elsewhere: a hand-written dead-code scanner, 137 false out of 177.
  const hits = [
    ...Array(40).fill({ matchedIn: "comment" }),
    ...Array(137 - 40).fill({ matchedIn: "string-literal" }),
    ...Array(40).fill({ matchedIn: "call-expression" }),
  ]
  const v = textRuleFitness({ hits, name: "dead-code scan" })
  assert.equal(v.ok, false)
  assert.ok(v.precision < 0.3)
  assert.match(v.reason, /Give it a lexer before it gates anything/)
})

test("a precise rule passes", () => {
  const hits = [...Array(19).fill({ matchedIn: "call-expression" }), { matchedIn: "comment" }]
  assert.equal(textRuleFitness({ hits }).ok, true)
})
