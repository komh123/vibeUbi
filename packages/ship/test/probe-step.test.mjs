/**
 * The probe step is `mutates: true`, so the claim is not "it reports" — it is
 * "a P0 red here rolls back". These tests drive a whole ship and check the
 * outcome and whether rollback was actually called.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ship, SHIP_STEPS } from "../src/run.mjs"

const DISCOVERED = [{ id: "page:/login", kind: "page" }]
const DECLARED = [{ id: "page:/login", priority: "P0", testId: "app-page-login" }]

/** A target that swaps, proves, and records whether it was rolled back. */
const fakeTarget = (state) => ({
  proofClaim: { external: true, carriesArtifactId: true, source: "test" },
  async build() { return {} },
  async artifactId() { return "new-1" },
  async previousArtifactId() { return "old-0" },
  async swap() { state.live = "new-1" },
  async rollback() { state.rolledBack = true; state.live = "old-0" },
  async proof({ expected, previous }) { return { expected, previous, observed: state.live } },
})

const run = async (probe, state) => {
  const root = await mkdtemp(join(tmpdir(), "vibeubi-probe-"))
  try {
    await writeFile(join(root, "package.json"), '{"name":"x"}', "utf8")
    let done = null
    const cells = []
    await ship({
      root, discovered: DISCOVERED,
      config: {
        base: "http://127.0.0.1:1", declared: DECLARED, verify: [], layers: [],
        memory: { cgroupLimitMb: 16_384, availableMb: 16_384 },
        sweep: async function* () {}, probe,
      },
      target: fakeTarget(state),
      emit: (e) => { if (e.kind === "done") done = e; if (e.kind === "cell") cells.push(e.cell) },
    })
    return { done, cells }
  } finally { await rm(root, { recursive: true, force: true }) }
}

test("the step is declared as mutating, because it can roll back", () => {
  const probe = SHIP_STEPS.find((s) => s.id === "probe")
  assert.ok(probe, "the step must exist in the canonical list")
  assert.equal(probe.mutates, true)
  assert.equal(SHIP_STEPS.at(-1).id, "report", "probe goes BEFORE report")
  assert.equal(SHIP_STEPS[SHIP_STEPS.indexOf(probe) - 1].id, "gate", "and AFTER gate — it is the expensive step")
})

test("a P0 FAIL from the skill rolls the deploy back", async () => {
  const state = { live: "old-0", rolledBack: false }
  const { done } = await run({
    fulfil: async (order) => ({
      skill: order.skill, artifactId: order.artifactId,
      observed: [{ id: "page:/login", verdict: "FAIL", why: "the login form never mounted" }],
    }),
  }, state)
  assert.equal(state.rolledBack, true, "a broken P0 page that ships anyway makes this a report, not a gate")
  assert.match(done.outcome, /rolled back/)
})

test("a clean report ships, and the probe cells reach the report", async () => {
  const state = { live: "old-0", rolledBack: false }
  const { done, cells } = await run({
    fulfil: async (order) => ({
      skill: order.skill, artifactId: order.artifactId,
      observed: [{ id: "page:/login", verdict: "PASS", evidence: { errors: 0 } }],
    }),
  }, state)
  assert.equal(done.outcome, "shipped")
  assert.equal(state.rolledBack, false)
  assert.ok(cells.some((c) => c.layer === "probe" && c.status === "pass"))
})

test("a skill that reports NOTHING rolls back — silence is not a pass", async () => {
  const state = { live: "old-0", rolledBack: false }
  const { done } = await run({
    fulfil: async (order) => ({ skill: order.skill, artifactId: order.artifactId, observed: [] }),
  }, state)
  assert.equal(state.rolledBack, true)
  assert.match(done.outcome, /rolled back/)
})

test("and the operator is told WHICH item, not just a count", async () => {
  // The verdict line is "1 layer(s) errored" — a count, not a diagnosis. The
  // reason lives on the cell, and the step prints it, because an operator's
  // first line should not send them to a file to find out what broke.
  const state = { live: "old-0", rolledBack: false }
  const said = []
  const root = await mkdtemp(join(tmpdir(), "vibeubi-why-"))
  try {
    await writeFile(join(root, "package.json"), '{"name":"x"}', "utf8")
    await ship({
      root, discovered: DISCOVERED,
      config: {
        base: "http://127.0.0.1:1", declared: DECLARED, verify: [], layers: [],
        memory: { cgroupLimitMb: 16_384, availableMb: 16_384 }, sweep: async function* () {},
        probe: { fulfil: async (o) => ({ skill: o.skill, artifactId: o.artifactId, observed: [] }) },
      },
      target: fakeTarget(state),
      emit: (e) => { if (e.msg) said.push(String(e.msg)) },
    })
    assert.ok(said.some((m) => m.includes("page:/login") && /ordered and not reported/.test(m)),
      `the operator never saw which item failed. Lines were:\n${said.join("\n")}`)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("a STALE result — right shape, previous artifact — rolls back", async () => {
  const state = { live: "old-0", rolledBack: false }
  const { done } = await run({
    fulfil: async (order) => ({
      skill: order.skill, artifactId: "a-build-from-yesterday",
      observed: [{ id: "page:/login", verdict: "PASS" }],
    }),
  }, state)
  assert.equal(state.rolledBack, true, "yesterday's green file must not pass today's ship")
  assert.match(done.outcome, /rolled back/)
})

test("the slot really is a slot: a different skill name is refused", async () => {
  const state = { live: "old-0", rolledBack: false }
  const { done } = await run({
    skill: "security-review",
    fulfil: async (order) => ({ skill: "dom-test", artifactId: order.artifactId, observed: [{ id: "page:/login", verdict: "PASS" }] }),
  }, state)
  assert.equal(state.rolledBack, true, "a swapped slot answering a different question must not pass")
  assert.match(done.outcome, /rolled back/)
})

test("probe.skill: false disables the step without pretending it passed", async () => {
  const state = { live: "old-0", rolledBack: false }
  const { done, cells } = await run({ skill: false }, state)
  assert.equal(done.outcome, "shipped")
  assert.equal(cells.filter((c) => c.layer === "probe").length, 0)
})

test("nothing to probe is honest, not green", async () => {
  const root = await mkdtemp(join(tmpdir(), "vibeubi-noprobe-"))
  try {
    await writeFile(join(root, "package.json"), '{"name":"x"}', "utf8")
    const state = { live: "old-0", rolledBack: false }
    let done = null
    await ship({
      root, discovered: [{ id: "api:/x", kind: "api" }],   // no pages at all
      config: {
        base: "http://127.0.0.1:1", declared: [], verify: [], layers: [],
        memory: { cgroupLimitMb: 16_384, availableMb: 16_384 },
        sweep: async function* () {}, probe: {},
      },
      target: fakeTarget(state),
      emit: (e) => { if (e.kind === "done") done = e },
    })
    assert.equal(done.outcome, "shipped")
  } finally { await rm(root, { recursive: true, force: true }) }
})
