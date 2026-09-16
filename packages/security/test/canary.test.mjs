/**
 * A dead scanner and a clean project report the same thing. These tests are
 * about the second half of that sentence: that a scanner which has stopped
 * working is DETECTED, and that detecting it actually stops a run.
 *
 * The idea is a peer session's, from an e2e counter that set `{ total: 0 }` and
 * then threw before attaching its observer. It read 0 for two full rounds of
 * testing with nothing counting, and the only thing that ever told it apart
 * from a genuinely quiet page was injecting a card.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runCanaries, CANARIES } from "../src/canary.mjs"
import { runScan } from "../src/run.mjs"
import * as collect from "../src/collect.mjs"

test("every rule proves it still fires on its own sample", () => {
  const r = runCanaries(["S0", "S2", "S4"])
  assert.deepEqual(r.dead, [], r.dead.map((d) => `${d.rule}: ${d.why}`).join("; "))
  assert.equal(r.checked.length, CANARIES.length)
})

test("a rule that stops matching is caught, and says which of two things went wrong", () => {
  const broken = { layer: "S0", rule: "S0.fake", run: () => [] }
  const all = [...CANARIES]
  CANARIES.length = 0; CANARIES.push(broken)
  try {
    const r = runCanaries(["S0"])
    assert.equal(r.ok, false)
    assert.match(r.dead[0].why, /Either the rule stopped matching, or the sample stopped being an example/)
  } finally { CANARIES.length = 0; CANARIES.push(...all) }
})

test("a rule that THROWS on its own sample is caught, not swallowed", () => {
  const explodes = { layer: "S0", rule: "S0.fake", run: () => { throw new Error("lines is not iterable") } }
  const all = [...CANARIES]
  CANARIES.length = 0; CANARIES.push(explodes)
  try {
    const r = runCanaries(["S0"])
    assert.match(r.dead[0].why, /threw on its own sample: lines is not iterable/)
  } finally { CANARIES.length = 0; CANARIES.push(...all) }
})

test("canaries only run for layers that were requested", () => {
  assert.equal(runCanaries([]).checked.length, 0)
  assert.equal(runCanaries(["S4"]).checked.length, CANARIES.filter((c) => c.layer === "S4").length)
})

test("a dead canary WITHHOLDS the grade and blocks — being present is not being wired", async () => {
  const root = await mkdtemp(join(tmpdir(), "vibeubi-canary-"))
  const all = [...CANARIES]
  CANARIES.length = 0
  CANARIES.push({ layer: "S2", rule: "S2.route.ungated", run: () => [] })
  try {
    await writeFile(join(root, "package.json"), '{"name":"x"}', "utf8")
    const r = await runScan({
      root, layers: ["S2"], discovered: [{ kind: "api", id: "api:/a", path: "/a", source: "a.js" }],
      config: { gateTokens: ["verifyToken"] },
    })
    assert.equal(r.grade.grade, "—", "a scan whose scanner cannot be shown to work must not be graded")
    assert.ok(r.blocking.length > 0, "and it must block, or it is a warning nobody reads")
    assert.ok(r.skipped.some((s) => /cannot be shown to work/.test(s)))
  } finally {
    CANARIES.length = 0; CANARIES.push(...all)
    await rm(root, { recursive: true, force: true })
  }
})

test("the canary file is never itself scanned — its whole content is bait", async () => {
  const REPO = new URL("../../..", import.meta.url).pathname
  const files = await collect.walk(REPO)
  const seen = (await collect.scannableFiles(REPO, files)).map((f) => f.path)
  const code = (await collect.codeFiles(REPO, files)).map((f) => f.path)
  for (const list of [seen, code]) {
    assert.ok(!list.includes("packages/security/src/canary.mjs"),
      "the scanner flagged its own bait — a fake key and an unsanitised sink reported as real findings")
  }
  // and the exemption must not have grown into a pattern that hides real files
  assert.ok(seen.some((p) => p.startsWith("packages/security/src/")),
    "the exemption swallowed the directory it lives in")
})
