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
