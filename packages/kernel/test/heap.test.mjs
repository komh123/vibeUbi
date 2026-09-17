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

/* ── a ceiling that is not a ceiling, or is worse than none ───────────── */
import { ceilingEffect, weightOf, unknownSeverities, atOrAbove as above } from "../src/index.mjs"
import v8 from "node:v8"

const defaultOldSpace = () => Math.round(v8.getHeapStatistics().heap_size_limit / 1024 / 1024) - 48

test("the three effects, and which two mean the flag is not buying anything", () => {
  const d = defaultOldSpace()
  assert.ok(d > 0)
  assert.equal(ceilingEffect(d + 4000, d).effect, "raises")
  assert.equal(ceilingEffect(d, d).effect, "equals")
  assert.equal(ceilingEffect(d - 1024, d).effect, "lowers")
  assert.equal(ceilingEffect(d, d).ineffective, true)
  assert.equal(ceilingEffect(d - 1024, d).ineffective, true)
  assert.equal(ceilingEffect(d + 4000, d).ineffective, false)
})

test("`lowers` is named separately because it INVERTS the feature", () => {
  const d = defaultOldSpace()
  assert.equal(ceilingEffect(d, d).worse, false, "equal is harmless — the flag did nothing")
  assert.equal(ceilingEffect(d - 1024, d).worse, true,
    "below the default means the pipeline made an OOM MORE likely than not running at all")
})

test("with no measured default it claims nothing rather than something cheerful", () => {
  for (const bad of [0, NaN, -1, undefined]) {
    const e = ceilingEffect(4096, bad)
    assert.equal(e.ineffective, false)
    assert.equal(e.worse, false)
  }
})

test("the harmful band is pinned, so a change to the share or clamps must re-measure", () => {
  // Measured on this machine (default old-space 4096): 6 GB available derives
  // 3072 — lower than the default, and the first version of this predicate,
  // which only answered equality, was silent for exactly this row.
  const d = defaultOldSpace()
  const at = (gb) => nodeHeapMb({ availableMb: gb * 1024, reserveMb: 2048 }).heapMb
  const worse = [4, 5, 6, 7, 8, 10, 12, 16, 24].filter((gb) => ceilingEffect(at(gb), d).worse)
  const raises = [4, 5, 6, 7, 8, 10, 12, 16, 24].filter((gb) => ceilingEffect(at(gb), d).effect === "raises")
  assert.ok(worse.length > 0, "if nothing is ever worse on this machine the warning is dead code and should be deleted")
  assert.ok(raises.length > 0, "and if nothing ever raises, the whole formula is doing harm")
  assert.ok(Math.max(...worse) < Math.min(...raises),
    `the bands must not interleave: worse at ${worse.join(",")} GB, raises at ${raises.join(",")} GB`)
})

/* ── an unrecognised severity is not free ─────────────────────────────── */
test("a misspelled severity weighs as high, not as zero", () => {
  assert.equal(weightOf("HIGH"), weightOf("high"), "case was already handled")
  assert.equal(weightOf(" high "), weightOf("high"), "so is whitespace")
  assert.equal(weightOf("sev-1"), weightOf("high"),
    "an unknown severity used to cost nothing and appear in the report like any other row")
  assert.equal(weightOf(undefined), weightOf("high"))
})

test("and it blocks, so a typo cannot be the quietest way to disable a gate", () => {
  assert.equal(above("sev-1"), true)
  assert.equal(above("Critical!"), true)
  assert.equal(above("low"), false, "the fallback must not make everything block")
  assert.equal(above("info"), false)
})

test("unknown severities are listed, so the rule that spelled it wrong can be found", () => {
  const out = unknownSeverities([{ severity: "high" }, { severity: "sev-1" }, { severity: "SEV-1" }, { severity: "low" }])
  assert.deepEqual(out, ["sev-1"])
})

/* ── two unreadable values are two absences, not a match ──────────────── */
import { sameObserved } from "../src/index.mjs"

test("`unreadable` needs a representation equal to no real value", () => {
  // A peer's generalisation of three defects at three type levels: `?? 0` on a
  // score, an empty-string version field, and a /version endpoint answering
  // "unknown". null has such a representation; "", 0 and false do not.
  assert.deepEqual(
    { known: sameObserved("", "").known, same: sameObserved("", "").same },
    { known: false, same: false },
    "two empty strings compare equal — a field NEITHER side could read would report agreement",
  )
  assert.equal(sameObserved(null, "x").known, false)
  assert.equal(sameObserved("x", undefined).known, false)
  assert.equal(sameObserved("  ", "  ").known, false, "whitespace is not a reading either")
})

test("but a real zero is a real value, and must not be treated as absent", () => {
  const r = sameObserved(0, 0, { what: "count" })
  assert.equal(r.known, true)
  assert.equal(r.same, true, "the CALLER must use null for unreadable; 0 is data")
})

test("it says which side could not be read, because the two fixes differ", () => {
  assert.match(sameObserved(null, "x").reason, /the first side could not be read/)
  assert.match(sameObserved("x", null).reason, /the second side could not be read/)
  assert.match(sameObserved(null, null).reason, /neither side could be read/)
})

test("same and different are still plainly answered", () => {
  assert.equal(sameObserved("a", "a").same, true)
  assert.equal(sameObserved("a", "b").same, false)
  assert.equal(sameObserved("a", "b").known, true)
})
