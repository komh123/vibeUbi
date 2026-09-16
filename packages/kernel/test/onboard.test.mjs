/**
 * The promise `onboard` makes is "one command, the fewest questions, and every
 * question is one only you can answer". These tests are the second half of that
 * sentence: they pin which questions exist and, more importantly, that the two
 * un-guessable ones are never skipped.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { onboardStage, baselinePlan, prunePlan, STAGES } from "../src/onboard.mjs"
import { baselineAdmission } from "../src/index.mjs"

const READY = { plugins: ["x"], gateTokens: ["verifyToken"], versionPath: "/api/version" }
const asked = (r) => r.asks.map((a) => a.id)

test("no config at all starts at detect and asks nothing yet", () => {
  const r = onboardStage({ config: null })
  assert.equal(r.stage, "detect")
  assert.equal(r.blocked, false, "the first run should DO something, not interrogate")
})

test("the proof endpoint is always asked and never inferred", () => {
  const r = onboardStage({ config: { ...READY, versionPath: undefined }, probe: { framework: "express" } })
  assert.ok(asked(r).includes("proof"))
  assert.match(r.asks.find((a) => a.id === "proof").why, /nothing else reports an error/)
})

test("an unnamed auth helper is a stop, not a wall of red", () => {
  const r = onboardStage({ config: { ...READY, gateTokens: [] } })
  assert.ok(asked(r).includes("gateTokens"))
})

test("an unrecognised stack is a stop — an empty registry is not a clean one", () => {
  const r = onboardStage({ config: { gateTokens: ["g"], versionPath: "/v" }, probe: { framework: null } })
  assert.ok(asked(r).includes("discoverer"))
})

test("a discoverer that found zero things stops instead of passing", () => {
  const r = onboardStage({ config: READY, discovered: { total: 0, orphans: 0 } })
  assert.equal(r.stage, "inventory")
  assert.ok(asked(r).includes("discoverer"))
})

test("orphans move it to claim, and name the two fields the gate reads", () => {
  const r = onboardStage({ config: READY, discovered: { total: 66, orphans: 61 } })
  assert.equal(r.stage, "claim")
  assert.match(r.asks[0].why, /priority and requiredRole/)
})

test("a baseline is never drawn over checks that did not run", () => {
  const r = onboardStage({
    config: READY, discovered: { total: 66, orphans: 0 },
    scan: { blocking: [1, 2], coverage: { ok: false, unmeasured: ["S2 — nothing discovered"] } },
  })
  assert.equal(r.stage, "baseline")
  assert.ok(asked(r).includes("coverage"))
  assert.match(r.asks[0].why, /coverage hole as accepted debt/)
})

test("blocking findings with no baseline stop at baseline", () => {
  const r = onboardStage({
    config: READY, discovered: { total: 66, orphans: 0 },
    scan: { blocking: [1, 2, 3], coverage: { ok: true } },
  })
  assert.equal(r.stage, "baseline")
  assert.match(r.asks[0].why, /a gate people DELETE/)
})

test("everything settled reaches gated, and gated is the last stage", () => {
  const r = onboardStage({
    config: { ...READY, baseline: [{ fingerprint: "a" }] },
    discovered: { total: 66, orphans: 0 },
    scan: { blocking: [1], coverage: { ok: true } },
  })
  assert.equal(r.stage, "gated")
  assert.equal(r.done, true)
  assert.equal(STAGES.at(-1).id, "gated")
})

test("a NEW project — nothing to adopt, nothing to baseline — reaches gated immediately", () => {
  const r = onboardStage({ config: READY, discovered: { total: 3, orphans: 0 }, scan: { blocking: [], coverage: { ok: true } } })
  assert.equal(r.stage, "gated")
  assert.deepEqual(r.asks, [], "a greenfield project should be asked nothing beyond stage 0")
})

/* ── baseline ─────────────────────────────────────────────────────────── */
const F = (fp, sev = "high") => ({ fingerprint: fp, rule: "S0.secret", severity: sev })

test("a false positive is refused, not absorbed", () => {
  const r = baselinePlan([F("a")], { a: { verdict: "false-positive", reason: "the rule is wrong" } }, baselineAdmission)
  assert.equal(r.admit.length, 0)
  assert.match(r.refused[0].why, /fixed in the RULE/)
})

test("correct behaviour is refused too", () => {
  const r = baselinePlan([F("a")], { a: { verdict: "correct-behaviour", reason: "it is supposed to 404" } }, baselineAdmission)
  assert.equal(r.admit.length, 0)
})

test("real debt with no written reason is refused", () => {
  const r = baselinePlan([F("a")], { a: { verdict: "real", reason: "  " } }, baselineAdmission)
  assert.equal(r.admit.length, 0)
  assert.match(r.refused[0].why, /a decision or an accident/)
})

test("real debt with a reason is admitted, and stamped with a date", () => {
  const r = baselinePlan([F("a")], { a: { verdict: "real", reason: "rotation scheduled, see SECRET-ROTATION.md" } }, baselineAdmission, 1700)
  assert.equal(r.admit.length, 1)
  assert.equal(r.admit[0].acceptedAt, 1700, "without a date debtAge can never say how long it has stood")
  assert.equal(r.admit[0].reason, "rotation scheduled, see SECRET-ROTATION.md")
})

test("a finding with no decision is neither admitted nor refused — it is still open", () => {
  const r = baselinePlan([F("a"), F("b")], { a: { verdict: "real", reason: "ok" } }, baselineAdmission)
  assert.equal(r.admit.length, 1)
  assert.equal(r.undecided.length, 1)
})

test("debt that no longer appears is reported as fixed, not silently kept", () => {
  const p = prunePlan([{ fingerprint: "old" }, { fingerprint: "still" }], [F("still")])
  assert.deepEqual(p.stale.map((s) => s.fingerprint), ["old"])
  assert.equal(p.keep.length, 1)
  assert.match(p.reason, /they were fixed/)
})

test("nothing to prune says so rather than inventing news", () => {
  assert.equal(prunePlan([{ fingerprint: "a" }], [F("a")]).reason, null)
})
