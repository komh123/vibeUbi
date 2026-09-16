import { test } from "node:test"
import assert from "node:assert/strict"
import { nodeHeapMb, heapOomMessage, killScope, HEAP_FLOOR_MB, HEAP_CEILING_MB } from "../src/heap.mjs"
import { baselineAdmission, baselineDiff } from "../src/index.mjs"

test("the one load-bearing property: fenced heap stays STRICTLY under the fence", () => {
  for (const limit of [2731, 4096, 8192, 12000, 32768, 65536]) {
    const r = nodeHeapMb({ cgroupLimitMb: limit })
    assert.ok(r.heapMb < limit,
      `heap ${r.heapMb} >= fence ${limit} — the cgroup kills first and you get exit 137, which is harder to read than V8's message`)
  }
})

test("the reserve applies to the UNFENCED branch only — a cgroup already had it taken out", () => {
  const a = nodeHeapMb({ cgroupLimitMb: 8192, reserveMb: 4096 })
  const b = nodeHeapMb({ cgroupLimitMb: 8192, reserveMb: 0 })
  assert.equal(a.heapMb, b.heapMb, "subtracting the machine reserve twice is the difference between a step that runs and one that cannot start")
  const c = nodeHeapMb({ availableMb: 12_000, reserveMb: 4096 })
  const d = nodeHeapMb({ availableMb: 12_000, reserveMb: 0 })
  assert.ok(c.heapMb < d.heapMb, `unfenced, the reserve must bite (${c.heapMb} vs ${d.heapMb})`)
})

test("on a large machine the ceiling dominates and the reserve stops mattering", () => {
  // Written because the first version of the test above used 32 GB, where
  // 0.75 x (32768 - 4096) and 0.75 x 32768 both clamp to the ceiling — so it
  // asserted "the reserve bites" against two numbers that could never differ.
  const big = nodeHeapMb({ availableMb: 32768, reserveMb: 4096 })
  assert.equal(big.heapMb, HEAP_CEILING_MB)
  assert.equal(nodeHeapMb({ availableMb: 32768, reserveMb: 0 }).heapMb, HEAP_CEILING_MB)
})

test("the floor is never allowed to break the property it shares a function with", () => {
  const r = nodeHeapMb({ cgroupLimitMb: 1500 })   // smaller than the 2048 floor
  assert.ok(r.heapMb < 1500)
  assert.equal(r.tooSmall, true)
  assert.match(r.why, /below this pipeline's 2048 MB floor/)
})

test("clamped both ways, on both branches", () => {
  assert.equal(nodeHeapMb({ availableMb: 1024, reserveMb: 0 }).heapMb, HEAP_FLOOR_MB)
  assert.equal(nodeHeapMb({ availableMb: 512_000, reserveMb: 0 }).heapMb, HEAP_CEILING_MB)
  assert.equal(nodeHeapMb({ cgroupLimitMb: 500_000 }).heapMb, HEAP_CEILING_MB)
})

test("everything is MB — no gigabyte rounding eats up to 1 GB before the multiply", () => {
  const lo = nodeHeapMb({ availableMb: 16_000, reserveMb: 0 }).heapMb
  const hi = nodeHeapMb({ availableMb: 16_999, reserveMb: 0 }).heapMb
  assert.ok(hi > lo, "999 MB of difference disappeared — that is the floor-on-GB bug")
})

test("every branch says WHY, because the caller has to print it", () => {
  for (const r of [nodeHeapMb({ cgroupLimitMb: 8192 }), nodeHeapMb({ availableMb: 32768, reserveMb: 4096 }), nodeHeapMb({ cgroupLimitMb: 900 })]) {
    assert.ok(r.why.length > 40)
  }
})

test("heapOomMessage returns null for anything that is not a V8 OOM", () => {
  assert.equal(heapOomMessage({ output: "Killed", forStep: "tsc", heapMb: 8192 }), null,
    "exit 137 is a cgroup kill and needs a different message — falling through is the point")
  assert.equal(heapOomMessage({ output: "1 test failed", forStep: "unit", heapMb: 4096 }), null)
})

test("heapOomMessage fires on both of V8's phrasings, and keeps the self-lock line", () => {
  for (const out of ["FATAL ERROR: JavaScript heap out of memory", "Ineffective mark-compacts near heap limit Allocation failed"]) {
    const m = heapOomMessage({ output: out, forStep: "tsc --noEmit", heapMb: 8192, availableMb: 64_000 })
    assert.match(m, /SELF-LOCKS/, "without this the operator reruns, sees the same failure, and blames the machine")
    assert.match(m, /NOT the machine running out of memory/)
    assert.match(m, /tourniquet/)
    assert.match(m, /62 GB available/)
  }
})

test("the kill DECISION is one, the mechanism branches by platform", () => {
  assert.equal(killScope("linux").strategy, "process-group")
  assert.equal(killScope("darwin").strategy, "process-group")
  assert.equal(killScope("win32").strategy, "taskkill")
  // what must never differ: that the whole tree is the target
  for (const p of ["linux", "darwin", "win32"]) assert.match(killScope(p).why, /tree/)
})

/* ── the hole a peer session found in the withheld-grade change ────────── */
test("a coverage hole cannot be accepted as debt", () => {
  const r = baselineAdmission({ rule: "B.coverage.unmeasured", admissible: false, verdict: "real", reason: "we will wire the adapter later" })
  assert.equal(r.admit, false)
  assert.match(r.reason, /whole content of this finding is that nobody did/)
})

test("and pasting its fingerprint into the baseline by hand does not silence it either", () => {
  const f = { fingerprint: "x", severity: "high", rule: "B.coverage.unmeasured", admissible: false }
  const d = baselineDiff([f], [{ fingerprint: "x" }])
  assert.equal(d.blocking.length, 1, "grade said '—' and the exit code still went 1 → 0; the exit code is what CI reads")
  assert.equal(d.known.length, 0)
})

/* ── reason codes, and the refusal policy ──────────────────────────────── */
test("every branch carries a machine-readable reason and the numbers behind it", () => {
  const cases = [
    [nodeHeapMb({ cgroupLimitMb: 8192 }), "fenced"],
    [nodeHeapMb({ cgroupLimitMb: 900 }), "fence-below-floor"],
    [nodeHeapMb({ availableMb: 12_000, reserveMb: 2048 }), "unfenced"],
  ]
  for (const [r, code] of cases) {
    assert.equal(r.reason, code)
    assert.ok(Object.keys(r.numbers).length >= 2,
      "a consumer that renders its own sentence must not have to re-derive the arithmetic")
    for (const v of Object.values(r.numbers)) assert.equal(typeof v, "number")
  }
})

test("a fence too small to honour the floor is flagged, not quietly obeyed", () => {
  // The peer's catch: 100 MB fence -> 75 MB heap, which will not run node at
  // all. The kernel reports; the POLICY (refuse) belongs to the caller, and
  // ship now refuses rather than warning and running it anyway.
  for (const mb of [100, 256, 512, 1000, 2000]) {
    const r = nodeHeapMb({ cgroupLimitMb: mb })
    assert.equal(r.tooSmall, true, `${mb} MB fence should be flagged`)
    assert.ok(r.heapMb < mb, "still under the fence — the property holds even in the flagged case")
  }
})
