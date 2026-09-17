/**
 * The probe step is `mutates: true`, so the claim is not "it reports" — it is
 * "a P0 red here rolls back". These tests drive a whole ship and check the
 * outcome and whether rollback was actually called.
 */
import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import http from "node:http"
import { ship, SHIP_STEPS } from "../src/run.mjs"

/**
 * A real server, because the step now takes its OWN look at `base` before
 * judging — and with an unreachable base every one of these tests would be
 * measuring "the site is down" instead of what it claims to measure. The
 * previous version used 127.0.0.1:1 and went red the moment that look was
 * added, which is the check working.
 */
let server, BASE
before(async () => {
  server = http.createServer((_q, s) => { s.writeHead(200); s.end("ok") })
  await new Promise((r) => server.listen(0, "127.0.0.1", r))
  BASE = `http://127.0.0.1:${server.address().port}`
})
after(() => server?.close())

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
        base: BASE, declared: DECLARED, verify: [], layers: [],
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

test("a skill that reports NOTHING does not roll back — but the outcome SAYS so", async () => {
  // Changed deliberately after a peer's first real run rolled back a good
  // deploy because their test account's password had been rotated by the
  // pipeline's own sweep. Absence of evidence after a swap is not evidence
  // against the build; it is a gap, and the protection against this becoming
  // decoration is that the number is printed.
  const state = { live: "old-0", rolledBack: false }
  const { done } = await run({
    fulfil: async (order) => ({ skill: order.skill, artifactId: order.artifactId, observed: [] }),
  }, state)
  assert.equal(state.rolledBack, false, "a measurement failure must not swap out a build that passed everything measurable")
  assert.equal(done.outcome, "shipped")
  assert.match(done.reason, /1 P0 page\(s\) could not be verified/,
    "shipping silently on an unverified P0 page is how this step becomes decoration")
})

test("a real FAIL still rolls back — the difference is positive evidence", async () => {
  const state = { live: "old-0", rolledBack: false }
  const { done } = await run({
    fulfil: async (order) => ({
      skill: order.skill, artifactId: order.artifactId,
      observed: [{ id: "page:/login", verdict: "FAIL", why: "form never mounted" }],
    }),
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
        base: BASE, declared: DECLARED, verify: [], layers: [],
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
        base: BASE, declared: [], verify: [], layers: [],
        memory: { cgroupLimitMb: 16_384, availableMb: 16_384 },
        sweep: async function* () {}, probe: {},
      },
      target: fakeTarget(state),
      emit: (e) => { if (e.kind === "done") done = e },
    })
    assert.equal(done.outcome, "shipped")
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("end to end: the site goes down after prove, the skill says BLOCKED, and it ROLLS BACK", async () => {
  // The hole that the after-swap leniency opened, closed by the step taking its
  // own look. Nothing about the skill's words changes — only whether the base
  // is serving when the judgement is made.
  const root = await mkdtemp(join(tmpdir(), "vibeubi-down-"))
  const dead = http.createServer((_q, s) => { s.writeHead(503); s.end("down") })
  await new Promise((r) => dead.listen(0, "127.0.0.1", r))
  const deadBase = `http://127.0.0.1:${dead.address().port}`
  try {
    const state = { live: "old-0", rolledBack: false }
    let done = null
    await ship({
      root, discovered: DISCOVERED,
      config: {
        base: deadBase, declared: DECLARED, verify: [], layers: [],
        memory: { cgroupLimitMb: 16_384, availableMb: 16_384 }, sweep: async function* () {},
        probe: { fulfil: async (o) => ({ skill: o.skill, artifactId: o.artifactId,
          observed: [{ id: "page:/login", verdict: "BLOCKED", why: "the page never loaded" }] }) },
      },
      target: fakeTarget(state),
      emit: (e) => { if (e.kind === "done") done = e },
    })
    assert.equal(state.rolledBack, true, "a deploy that takes the site down must not ship on an honest BLOCKED")
    assert.match(done.outcome, /rolled back/)
  } finally { dead.close(); await rm(root, { recursive: true, force: true }) }
})

test("the proof's discriminating power is measured across deploys, not asserted", async () => {
  // Three ships against a target whose /version answers the same thing every
  // time — the `commit: null` shape. The deploys all succeed; what must happen
  // is that the pipeline SAYS the evidence is worthless.
  const root = await mkdtemp(join(tmpdir(), "vibeubi-power-"))
  try {
    await writeFile(join(root, "package.json"), '{"name":"x"}', "utf8")
    const said = []
    let n = 0
    const constantTarget = () => {
      const id = `build-${++n}`
      return {
        proofClaim: { external: true, carriesArtifactId: true, source: "test" },
        async build() { return {} },
        async artifactId() { return id },
        async previousArtifactId() { return n > 1 ? `build-${n - 1}` : null },
        async swap() {},
        async rollback() {},
        // answers with the expected id so the deploy proves, but ALWAYS also a
        // constant field — the real payload shape
        async proof({ expected, previous }) { return { expected, previous, observed: `${expected} version=0.1.0` } },
      }
    }
    for (let i = 0; i < 3; i++) {
      await ship({
        root, discovered: [],
        config: {
          base: BASE, declared: [], verify: [], layers: [],
          memory: { cgroupLimitMb: 16_384, availableMb: 16_384 },
          sweep: async function* () {}, probe: { skill: false },
        },
        target: constantTarget(),
        emit: (e) => { if (e.msg) said.push(String(e.msg)) },
      })
    }
    // the observed string contains the changing id, so it DOES discriminate —
    // this asserts the machinery ran and reached a verdict, not that it failed
    assert.ok(said.some((m) => /proof discriminates|may not be evidence/.test(m)),
      `the discrimination check never ran. Lines:\n${said.slice(-12).join("\n")}`)
    const hist = JSON.parse(await readFile(join(root, ".vibeubi", "proof-history.json"), "utf8"))
    assert.equal(hist.length, 3, "one sample per ship")
    assert.deepEqual(hist.map((h) => h.artifactId), ["build-1", "build-2", "build-3"])
  } finally { await rm(root, { recursive: true, force: true }) }
})
