import test from "node:test"
import assert from "node:assert/strict"
import { SYMPTOMS, findRule, mitigationStillPays, observationAge } from "../src/index.mjs"
import * as kernel from "../src/index.mjs"

/* ── the map must point at things that exist ──────────────────────────────── */

test("every rule named in the map is a real kernel export", () => {
  // A discovery map that sends somebody to a rule that does not exist is worse
  // than no map: they conclude the kernel is unreliable and stop looking. This
  // is the reverse-verification for the map itself.
  const missing = []
  for (const s of SYMPTOMS) {
    for (const name of s.rule.split("/").map((n) => n.trim())) {
      if (typeof kernel[name] === "undefined") missing.push(name)
    }
  }
  assert.deepEqual(missing, [], `named in SYMPTOMS but not exported: ${missing.join(", ")}`)
})

test("every entry carries a symptom somebody could actually search with", () => {
  for (const s of SYMPTOMS) {
    assert.ok(s.seen.length >= 2, `${s.rule} has fewer than two symptoms`)
    for (const line of s.seen) {
      assert.ok(line.length > 15, `${s.rule}: "${line}" is too short to be a search`)
      // The whole design is that the key is NOT the defect's name — you do not
      // know you have a `vacuousComparison` until after you have found it.
      assert.ok(
        !line.toLowerCase().includes(s.rule.toLowerCase()),
        `${s.rule}: the symptom names the rule, which is the one thing the searcher does not know`,
      )
    }
  }
})

/* ── the two queries the peer said they would have typed ──────────────────── */

test("the peer's own words find the rule they already had installed", () => {
  assert.equal(findRule("my scanner reported 0 and I believed it")[0].rule, "vacuousComparison")
  assert.equal(findRule("the gate is green on a machine where the feature does not exist")[0].rule, "testRanVerdict")
  assert.equal(findRule("two lists agree and both are empty")[0].rule, "sameObserved")
  assert.equal(findRule("I ran it with node 22 but the step got node 18")[0].rule, "runtimeFloorVerdict")
  assert.equal(findRule("the field is written and nothing reads it")[0].rule, "declaredFieldsAreRead")
})

test("a miss is an honest nothing, not the least-bad guess", () => {
  // A fuzzy matcher that always returns something sends you to read a rule that
  // does not apply. That costs more than the miss does.
  assert.deepEqual(findRule("kubernetes ingress annotation syntax"), [])
  assert.deepEqual(findRule(""), [])
  assert.deepEqual(findRule(null), [])
})

test("common English does not rank a rule", () => {
  // The first version scored a hit on "and" and put an unrelated rule third.
  assert.deepEqual(findRule("and the that with"), [])
})

/* ── observationAge: two kinds of never ───────────────────────────────────── */

const DAY = 86_400_000

test("never attempted is a coding task; attempted and never observed is a triage order", () => {
  const now = Date.now()

  const unwired = observationAge({ lastObservedAt: null, now })
  assert.equal(unwired.state, "never-wired")
  assert.equal(unwired.fix, "write it")

  // The peer's actual case: the probe WAS wired and correct, and an upstream
  // step had failed for a week, so the pipeline never reached it. Telling them
  // to write a probe would have been advice for a job already done.
  const starved = observationAge({ lastObservedAt: null, lastAttemptedAt: now - 7 * DAY, now })
  assert.equal(starved.state, "never-reached")
  assert.equal(starved.fix, "look upstream")
  assert.match(starved.reason, /IS wired/)
  assert.ok(!/is to write one/.test(starved.reason), "must not read as go-write-the-probe")

  assert.notEqual(unwired.reason, starved.reason)
  assert.equal(unwired.stale, true)
  assert.equal(starved.stale, true)
})

test("observed once, attempted since, silent ever after is starvation too", () => {
  const now = Date.now()
  const r = observationAge({ lastObservedAt: now - 90 * DAY, lastAttemptedAt: now - 1 * DAY, now })
  assert.equal(r.state, "reached-then-starved")
  assert.equal(r.fix, "look upstream")
  assert.equal(r.days, 90)
})

test("a caller that does not track attempts gets the undifferentiated answer, not a guess", () => {
  const now = Date.now()
  assert.equal(observationAge({ lastObservedAt: now - 90 * DAY, now }).state, "stale")
  assert.equal(observationAge({ lastObservedAt: now - 3 * DAY, now }).state, "fresh")
  assert.equal(observationAge({ lastObservedAt: now - 3 * DAY, now }).fix, null)
})

/* ── mitigationStillPays ──────────────────────────────────────────────────── */

test("the cache that grew until the warm path was the heavy one", () => {
  // Real numbers from the peer's machine. Written when the cache was 2.1 GB and
  // copying it was obviously cheaper than a cold build; measured at 14 GB, the
  // copy alone took 313s and the build peaked at 16.7 GB against a 21 GB wall.
  const whenWritten = mitigationStillPays({ mitigated: 2_100 + 4_000, plain: 9_000, ceiling: 21_000 })
  assert.equal(whenWritten.ok, true)

  const today = mitigationStillPays({ mitigated: 16_700 + 14_000, plain: 9_000, ceiling: 21_000, what: "the warm cache" })
  assert.equal(today.ok, false)
  assert.equal(today.known, true)
  assert.match(today.reason, /EXISTS/)
})

test("an unmeasured cost is not a satisfied comparison", () => {
  const r = mitigationStillPays({ mitigated: NaN, plain: 100 })
  assert.equal(r.ok, false)
  assert.equal(r.known, false)
  // Same rule as `sameObserved`: unreadable must not resolve to a pass.
  assert.equal(mitigationStillPays({ mitigated: 100, plain: undefined }).known, false)
})

test("equal costs do not count as paying for itself", () => {
  assert.equal(mitigationStillPays({ mitigated: 100, plain: 100 }).ok, false)
  assert.equal(mitigationStillPays({ mitigated: 99, plain: 100 }).ok, true)
})
