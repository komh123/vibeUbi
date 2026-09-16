/**
 * The declarations must not become the hand-written shadow they replaced.
 *
 * A consumer taking this kernel as a dependency wrote its own .d.ts and then
 * correctly called that the bigger risk: a mirror does not fail when the real
 * shape moves, it quietly stops describing it, and it looks safe while doing so.
 * Shipping the types upstream only helps if THEY are checked, so:
 *   - every runtime export is declared, and every declared name is exported
 *   - each branch of nodeHeapMb carries exactly the numbers its type promises
 * `npm run typecheck` covers the rest; this covers drift without needing tsc.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import * as kernel from "../src/index.mjs"
import { nodeHeapMb } from "../src/index.mjs"

const HERE = dirname(fileURLToPath(import.meta.url))

test("every runtime export is declared, and every declaration is exported", async () => {
  const dts = await readFile(join(HERE, "../src/index.d.ts"), "utf8")
  const declared = new Set([...dts.matchAll(/^export (?:declare )?(?:function|const|class) (\w+)/gm)].map((m) => m[1]))
  const runtime = Object.keys(kernel)

  const undeclared = runtime.filter((k) => !declared.has(k))
  assert.deepEqual(undeclared, [],
    `exported at runtime but not declared — a TypeScript consumer gets \`any\` for these: ${undeclared.join(", ")}`)

  const phantom = [...declared].filter((k) => !runtime.includes(k))
  assert.deepEqual(phantom, [],
    `declared but not exported — a consumer's import compiles and then fails at runtime: ${phantom.join(", ")}`)
})

test("each heap branch carries EXACTLY the numbers its type promises", () => {
  // The per-branch field sets are a deliberate design and were undocumented,
  // which is how a consumer invented a uniform one and read a field that does
  // not exist. Pinned here so the union and the implementation cannot diverge.
  const expected = {
    fenced: ["cgroupLimitMb", "nonHeapShare", "heapMb"],
    "fence-below-floor": ["cgroupLimitMb", "floorMb", "derivedMb"],
    unfenced: ["availableMb", "reserveMb", "usableMb", "share", "floorMb", "ceilingMb"],
  }
  const cases = [
    nodeHeapMb({ cgroupLimitMb: 8192 }),
    nodeHeapMb({ cgroupLimitMb: 900 }),
    nodeHeapMb({ availableMb: 12_000, reserveMb: 2048 }),
  ]
  for (const r of cases) {
    assert.deepEqual(Object.keys(r.numbers).sort(), expected[r.reason].sort(), `branch ${r.reason}`)
    for (const [k, v] of Object.entries(r.numbers)) {
      assert.equal(typeof v, "number", `${r.reason}.numbers.${k} must be a number — a renderer must not have to parse it`)
    }
  }
})

test("tooSmall is present only on the branch whose type declares it", () => {
  assert.equal(nodeHeapMb({ cgroupLimitMb: 900 }).tooSmall, true)
  assert.equal(nodeHeapMb({ cgroupLimitMb: 8192 }).tooSmall, undefined)
  assert.equal(nodeHeapMb({ availableMb: 12_000, reserveMb: 0 }).tooSmall, undefined)
})
