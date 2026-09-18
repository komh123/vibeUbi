/**
 * A checker that looked at nothing exits 0. So does one pointed at the wrong
 * half of the tree. Both were measured on a real project: a root tsconfig
 * excluded a whole runtime and the service on a user's own machine went four
 * months without a type check, green every time. The first real check found six
 * defects.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { coveredVerdict, crossLayerNames } from "../src/index.mjs"

test("a checker that read NOTHING is not a pass", () => {
  const r = coveredVerdict({ step: "typecheck", read: [], expected: ["a.ts", "b.ts"], how: "tsc --listFiles" })
  assert.equal(r.ok, false)
  assert.match(r.reason, /read NO files/)
  assert.match(r.reason, /tsc --listFiles/, "it must say how to ask the tool what it read")
  assert.deepEqual(r.unchecked, ["a.ts", "b.ts"])
})

test("a checker that skipped part of the tree names what it skipped", () => {
  const r = coveredVerdict({ step: "typecheck", read: ["a.ts"], expected: ["a.ts", "runtime/b.ts", "runtime/c.ts"] })
  assert.equal(r.ok, false)
  assert.deepEqual(r.unchecked, ["runtime/b.ts", "runtime/c.ts"])
  assert.match(r.reason, /four months/, "the number is the argument")
})

test("full coverage passes and says how much it was", () => {
  const r = coveredVerdict({ step: "typecheck", read: ["./a.ts", "b.ts"], expected: ["a.ts", "./b.ts"] })
  assert.equal(r.ok, true)
  assert.equal(r.checked, 2)
})

test("nothing to check is a real answer, not a failure", () => {
  // Calling it a failure is how an allow-list gets born.
  assert.deepEqual(coveredVerdict({ step: "typecheck", read: [], expected: [] }), { ok: true, checked: 0 })
})

/* ── two sides that must agree ────────────────────────────────────────── */

test("a name on one side only is a defect, and the report says WHICH side", () => {
  // Three feature names existed in a service and were never registered in the
  // protocol; frames were dropped in silence and a person saw 120 seconds of
  // nothing, then "your computer is not responding".
  const r = crossLayerNames({ a: ["open", "read", "write"], b: ["open"], aName: "service", bName: "protocol" })
  assert.equal(r.ok, false)
  assert.deepEqual(r.onlyA, ["read", "write"])
  assert.deepEqual(r.onlyB, [])
  assert.match(r.reason, /in service and not in protocol/)
  assert.match(r.reason, /only the pair is wrong/)
})

test("it is symmetrical — neither side is authoritative", () => {
  const r = crossLayerNames({ a: ["open"], b: ["open", "ghost"], aName: "service", bName: "protocol" })
  assert.deepEqual(r.onlyB, ["ghost"])
  assert.match(r.reason, /in protocol and not in service/)
})

test("agreement passes", () => {
  const r = crossLayerNames({ a: ["open", "read"], b: ["read", "open"] })
  assert.equal(r.ok, true)
  assert.equal(r.known, true)
})

test("two EMPTY lists agree perfectly, which is why they do not pass", () => {
  // Same rule as sameObserved: absence on both sides is two absences, never a
  // match. A discoverer that broke on both sides would otherwise read as green.
  const r = crossLayerNames({ a: [], b: [] })
  assert.equal(r.ok, false)
  assert.equal(r.known, false)
  assert.match(r.reason, /Two empty lists agree perfectly|neither .* produced any names/)
})

/* ── `engines` is enforced nowhere at run time ────────────────────────── */
import { runtimeFloorVerdict } from "../src/index.mjs"

test("a step below the declared floor is refused, and told where the floor lives", () => {
  const r = runtimeFloorVerdict({ step: "verify", running: "v18.19.1", floor: ">=22.0.0" })
  assert.equal(r.ok, false)
  assert.match(r.reason, /below the declared floor/)
  assert.match(r.reason, /npm at install time and by nothing at run time/)
  assert.match(r.reason, /use process\.execPath/)
})

test("equal to the floor passes; above passes; patch versions compare", () => {
  assert.equal(runtimeFloorVerdict({ running: "v22.0.0", floor: ">=22.0.0" }).ok, true)
  assert.equal(runtimeFloorVerdict({ running: "v24.21.0", floor: ">=22.0.0" }).ok, true)
  assert.equal(runtimeFloorVerdict({ running: "v22.14.0", floor: ">=22.15.0" }).ok, false, "22.14 < 22.15")
  assert.equal(runtimeFloorVerdict({ running: "v22.22.0", floor: ">=22.15" }).ok, true)
})

test("an unreadable version on either side is NOT a satisfied one", () => {
  // sameObserved's rule at a third type level: absence must not read as
  // agreement. A floor nobody could parse would otherwise pass everything.
  for (const [running, floor] of [[null, ">=22"], ["v22.0.0", null], ["", ">=22"], ["not-a-version", ">=22"]]) {
    const r = runtimeFloorVerdict({ running, floor })
    assert.equal(r.ok, false, `running=${running} floor=${floor}`)
    assert.equal(r.known, false)
  }
})

test("the symptom travels with the cross-layer gap", () => {
  // The gap and the timeout were ONE defect: three names dropped as bad_shape,
  // and what a person saw was 120 seconds of nothing. Pairing them is what
  // makes it findable from the symptom end.
  const r = crossLayerNames({
    a: ["open", "read"], b: ["open"], aName: "service", bName: "protocol",
    symptom: "a 120s timeout saying your computer is not responding",
  })
  assert.match(r.reason, /What a person sees when this happens: a 120s timeout/)
})
