/**
 * Acceptance is functional behaviour judged AFTER the swap, or liveness judged
 * BEFORE it. These tests drive whole ships and check two things the kernel
 * cannot: the ORDER in which things happen, and whether the target was touched.
 *
 * "Refused before anything was mutated" is asserted from the target's own call
 * log, not from the outcome string — an outcome is a report, and the log is what
 * actually happened.
 */
import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import http from "node:http"
import { ship, SHIP_STEPS, OBSERVED_MS, BUDGET_MS } from "../src/run.mjs"
import { budgetVerdict } from "../../kernel/src/index.mjs"

let server, BASE
before(async () => {
  server = http.createServer((_q, s) => { s.writeHead(200); s.end("ok") })
  await new Promise((r) => server.listen(0, "127.0.0.1", r))
  BASE = `http://127.0.0.1:${server.address().port}`
})
after(() => server?.close())

const DISCOVERED = [{ id: "page:/login", kind: "page" }]
const DECLARED = [{ id: "page:/login", priority: "P0", testId: "app-page-login" }]

/** A target that records every call, in order, in `log`. */
const fakeTarget = (state, extra = {}) => ({
  proofClaim: { external: true, carriesArtifactId: true, source: "test" },
  async build() { state.log.push("build"); return {} },
  async artifactId() { return "new-1" },
  async previousArtifactId() { return "old-0" },
  async swap() { state.log.push("swap"); state.live = "new-1" },
  async restart() { state.log.push("restart") },
  async rollback() { state.log.push("rollback"); state.rolledBack = true; state.live = "old-0" },
  async proof({ expected, previous }) { state.log.push(`proof:${state.live}`); return { expected, previous, observed: state.live } },
  ...extra,
})
const newState = () => ({ live: "old-0", rolledBack: false, log: [] })

const pass = (id, extra = {}) => ({ id, verdict: "PASS", ...extra })
const fail = (id, why = "broken") => ({ id, verdict: "FAIL", why })
const answer = (order, observed, extra = {}) => ({
  skill: order.skill, artifactId: order.artifactId, observedArtifact: order.artifactId, observed, ...extra,
})

const postSwap = (over = {}) => ({
  phase: "post-swap",
  items: [{ id: "acc:chat", severity: "P0" }, { id: "acc:export", severity: "P1" }],
  fulfil: async (order) => answer(order, order.items.map((i) => pass(i.id))),
  ...over,
})
const healthDecl = (over = {}) => ({
  phase: "pre-swap-health", healthOnly: true, timeBudgetMs: 5_000,
  items: [{ id: "health:login", severity: "P0", judges: "health" }],
  fulfil: async (order) => answer(order, order.items.map((i) => pass(i.id))),
  ...over,
})

async function go({ acceptance, state = newState(), probe = { skill: false }, target, sweep, base = BASE, targetAcceptance, extraConfig = {} }) {
  const root = await mkdtemp(join(tmpdir(), "vibeubi-acc-"))
  try {
    await writeFile(join(root, "package.json"), '{"name":"x"}', "utf8")
    const events = []
    const said = []
    let done = null
    await ship({
      root, discovered: DISCOVERED,
      config: {
        base, declared: DECLARED, verify: [], layers: [],
        memory: { cgroupLimitMb: 16_384, availableMb: 16_384 },
        sweep: sweep ?? (async function* () { state.log.push("sweep") }),
        probe, ...(acceptance ? { acceptance } : {}), ...extraConfig,
      },
      target: target ?? fakeTarget(state, targetAcceptance ? { acceptance: targetAcceptance } : {}),
      emit: (e) => {
        events.push(e)
        if (e.kind === "done") done = e
        if (e.msg) said.push(`${e.kind}: ${e.msg}`)
      },
    })
    const report = await readFile(join(done.outDir, "report.json"), "utf8").then(JSON.parse).catch(() => null)
    return { done, events, said, state, report, text: said.join("\n") }
  } finally { await rm(root, { recursive: true, force: true }) }
}
const ran = (events) => events.filter((e) => e.kind === "step" && e.state === "run").map((e) => e.id)

/* ── the step table ─────────────────────────────────────────────────────── */

test("the order is verify, health, build, swap, prove, sweep, gate, probe, acceptance, report", () => {
  assert.deepEqual(SHIP_STEPS.map((s) => s.id),
    ["verify", "health", "build", "swap", "prove", "sweep", "gate", "probe", "acceptance", "report"])
  const by = Object.fromEntries(SHIP_STEPS.map((s) => [s.id, s]))
  assert.equal(by.health.mutates, false, "health runs before anything is touched — that is its entire licence")
  assert.equal(by.acceptance.mutates, true, "a P0 red there rolls back")
  assert.equal(by.health.optional, true)
  assert.equal(by.acceptance.optional, true)
  assert.ok(!SHIP_STEPS.filter((s) => !["health", "acceptance"].includes(s.id)).some((s) => s.optional))
})

test("every step has a budget AND a measurement, so the budget rule still sees all ten", () => {
  const v = budgetVerdict({ clocked: SHIP_STEPS.map((s) => s.id), budgets: BUDGET_MS, observed: OBSERVED_MS })
  assert.equal(v.ok, true, v.reason)
  assert.ok("health" in BUDGET_MS && "acceptance" in BUDGET_MS && "health" in OBSERVED_MS && "acceptance" in OBSERVED_MS)
})

/* ── backward compatibility ─────────────────────────────────────────────── */

test("no acceptance declared: the steps that run are exactly the old ones, in the old order", async () => {
  const { done, events, state, report, text } = await go({})
  assert.equal(done.outcome, "shipped")
  assert.deepEqual(ran(events), ["verify", "build", "swap", "prove", "sweep", "gate", "probe", "report"].filter((s) => s !== "probe"),
    "probe is off in this harness (skill:false) and nothing new may appear")
  assert.ok(!events.some((e) => e.kind === "step" && (e.id === "health" || e.id === "acceptance") && e.state !== "skip"),
    "an undeclared optional step may only ever be reported as skipped")
  assert.deepEqual(state.log.filter((l) => !l.startsWith("proof")), ["build", "swap", "restart", "sweep"])
  assert.equal(report.acceptance, undefined, "no acceptance, nothing about it in the report")
  assert.doesNotMatch(text, /budget/i)
})

test("no acceptance declared: probe still runs between gate and report, as before", async () => {
  const { events } = await go({ probe: { fulfil: async (o) => ({ skill: o.skill, artifactId: o.artifactId, observed: [pass("page:/login")] }) } })
  assert.deepEqual(ran(events), ["verify", "build", "swap", "prove", "sweep", "gate", "probe", "report"])
})

test("step numbers are n/total and agree with each other (they were 1/7 … 6/8 before)", async () => {
  const plain = await go({})
  const heads = plain.events.filter((e) => e.kind === "head").map((e) => e.msg.match(/^(\d+)\/(\d+)/)).filter(Boolean)
  assert.ok(heads.length >= 6)
  assert.equal(new Set(heads.map((m) => m[2])).size, 1, "one total throughout")
  assert.deepEqual(heads.map((m) => Number(m[1])), heads.map((_, i) => i + 1), "and they count up without gaps")

  const full = await go({ acceptance: healthDecl(), probe: {} })
  const total = new Set(full.events.filter((e) => e.kind === "head").map((e) => e.msg.match(/^(\d+)\/(\d+)/)).filter(Boolean).map((m) => m[2]))
  assert.equal(total.size, 1)
})

/* ── post-swap ──────────────────────────────────────────────────────────── */

test("post-swap runs AFTER prove, sweep, gate and probe, and BEFORE report", async () => {
  const state = newState()
  const log = state.log
  const { done, events } = await go({
    state,
    sweep: async function* () { log.push("sweep") },
    probe: { fulfil: async (o) => { log.push("probe"); return { skill: o.skill, artifactId: o.artifactId, observed: [pass("page:/login")] } } },
    acceptance: postSwap({ fulfil: async (order) => { log.push("acceptance"); return answer(order, order.items.map((i) => pass(i.id))) } }),
  })
  assert.equal(done.outcome, "shipped")
  const at = (x) => log.findIndex((l) => l === x || l.startsWith(`${x}:`))
  assert.ok(at("swap") < at("proof") && at("proof") < at("sweep") && at("sweep") < at("probe") && at("probe") < at("acceptance"), log.join(" > "))
  assert.deepEqual(ran(events), ["verify", "build", "swap", "prove", "sweep", "gate", "probe", "acceptance", "report"])
  const idx = (id, state) => events.findIndex((e) => e.kind === "step" && e.id === id && e.state === state)
  assert.ok(idx("acceptance", "pass") < idx("report", "run"), "report is written last, after acceptance has been judged")
})

test("post-swap acceptance is told the NEW artifact and the production base", async () => {
  let seen
  await go({ acceptance: postSwap({ fulfil: async (order) => { seen = order; return answer(order, order.items.map((i) => pass(i.id))) } }) })
  assert.equal(seen.artifactId, "new-1")
  assert.equal(seen.base, BASE)
  assert.equal(seen.phase, "post-swap")
  assert.deepEqual(seen.items.map((i) => [i.id, i.priority]), [["acc:chat", "P0"], ["acc:export", "P1"]])
})

test("a post-swap P0 failure rolls back — and the rollback is PROVED, and the report names the item", async () => {
  const { done, state, report, text, events } = await go({
    acceptance: postSwap({ fulfil: async (order) => answer(order, [fail("acc:chat", "the model answered nothing"), pass("acc:export")]) }),
  })
  assert.equal(state.rolledBack, true)
  assert.equal(done.outcome, "rolled back", "proved, not merely attempted")
  assert.equal(state.log.filter((l) => l.startsWith("proof")).at(-1), "proof:old-0", "the rollback was observed from outside")
  assert.match(done.reason, /acc:chat/, "the outcome names WHICH item, not a count")
  assert.match(text, /acc:chat.*the model answered nothing/)
  assert.deepEqual(report.acceptance.failed.map((f) => f.id), ["acc:chat"])
  assert.equal(report.acceptance.failed[0].severity, "P0")
  assert.equal(report.outcome, "rolled back")
  assert.ok(report.cells.some((c) => c.layer === "acceptance" && c.feature === "acc:chat" && c.status === "fail"))
  assert.ok(events.some((e) => e.kind === "step" && e.id === "acceptance" && e.state === "fail"))
})

test("an unproven rollback is said, not shipped — same path as the probe's", async () => {
  const state = newState()
  const target = fakeTarget(state, { async proof({ expected, previous }) { state.log.push("proof"); return { expected, previous, observed: expected === "old-0" ? "something else" : state.live } } })
  const { done } = await go({ state, target, acceptance: postSwap({ fulfil: async (o) => answer(o, [fail("acc:chat")]) }) })
  assert.equal(done.outcome, "rollback unproven")
})

test("a post-swap P1 failure does NOT roll back: it ships, loudly, and the report keeps it", async () => {
  const { done, state, report, text } = await go({
    acceptance: postSwap({ fulfil: async (order) => answer(order, [pass("acc:chat"), fail("acc:export", "csv is empty")]) }),
  })
  assert.equal(state.rolledBack, false)
  assert.equal(done.outcome, "shipped")
  assert.match(text, /warn: .*acc:export.*csv is empty/)
  assert.match(done.reason, /acc:export|non-P0/)
  assert.deepEqual(report.acceptance.warnings.map((w) => w.id), ["acc:export"])
  assert.equal(report.acceptance.failed.length, 0, "failed means rolled back on; this is a warning")
})

test("an item the fulfiller never reported does not undo a good deploy — but is counted", async () => {
  const { done, state, report } = await go({ acceptance: postSwap({ fulfil: async (o) => answer(o, [pass("acc:export")]) }) })
  assert.equal(state.rolledBack, false)
  assert.equal(done.outcome, "shipped")
  assert.match(done.reason, /1 acceptance item\(s\) could not be verified/)
  assert.equal(report.acceptance.unverified, 1)
})

test("a result about a different build rolls back (admission is the probe's)", async () => {
  const { done, state } = await go({ acceptance: postSwap({ fulfil: async (o) => answer(o, o.items.map((i) => pass(i.id)), { artifactId: "yesterday" }) }) })
  assert.equal(state.rolledBack, true)
  assert.match(done.outcome, /rolled back/)
})

test("a fulfil that throws is a missing result: error, and it rolls back (as a probe with no result does)", async () => {
  const { done, state, text } = await go({ acceptance: postSwap({ fulfil: async () => { throw new Error("browser crashed") } }) })
  assert.equal(state.rolledBack, true)
  assert.match(text, /browser crashed/)
  assert.match(done.outcome, /rolled back/)
})

test("when the probe already rolled back, acceptance never runs", async () => {
  let called = false
  const { done, events } = await go({
    probe: { fulfil: async (o) => ({ skill: o.skill, artifactId: o.artifactId, observed: [fail("page:/login")] }) },
    acceptance: postSwap({ fulfil: async (o) => { called = true; return answer(o, []) } }),
  })
  assert.match(done.outcome, /rolled back/)
  assert.equal(called, false)
  assert.ok(events.some((e) => e.kind === "step" && e.id === "acceptance" && e.state === "unreached"))
})

test("when the gate rolled back, acceptance (declared) is reported NOT REACHED, not silently absent", async () => {
  const { events, done } = await go({
    acceptance: postSwap(),
    sweep: async function* () { yield { feature: "route:/x", layer: "S2", priority: "P0", status: "fail", reason: "open" } },
  })
  assert.match(done.outcome, /rolled back/)
  assert.ok(events.some((e) => e.kind === "step" && e.id === "acceptance" && e.state === "unreached"))
})

/* ── attempts ───────────────────────────────────────────────────────────── */

test("attempts: a P0 that fails then passes SHIPS, is called FLAKY, and the retry asks only about that item", async () => {
  const orders = []
  let n = 0
  const { done, state, report, text } = await go({
    acceptance: postSwap({
      items: [{ id: "acc:chat", severity: "P0", attempts: 3 }, { id: "acc:other", severity: "P0" }],
      fulfil: async (order) => {
        orders.push(order.items.map((i) => i.id))
        n++
        return answer(order, order.items.map((i) => (i.id === "acc:chat" && n === 1 ? fail(i.id, "timed out once") : pass(i.id))))
      },
    }),
  })
  assert.equal(done.outcome, "shipped")
  assert.equal(state.rolledBack, false)
  assert.deepEqual(orders, [["acc:chat", "acc:other"], ["acc:chat"]])
  assert.match(text, /warn: .*FLAKY.*acc:chat/)
  assert.deepEqual(report.acceptance.flaky.map((f) => f.feature), ["acc:chat"])
  assert.equal(report.acceptance.flaky[0].attempts, 2)
  assert.match(done.reason, /flaky/i, "a flaky pass is in the outcome, never silent")
})

test("attempts: failing every attempt still rolls back, and says how many were made", async () => {
  let calls = 0
  const { done, state, report } = await go({
    acceptance: postSwap({
      items: [{ id: "acc:chat", severity: "P0", attempts: 3 }],
      fulfil: async (o) => { calls++; return answer(o, [fail("acc:chat", "always")]) },
    }),
  })
  assert.equal(calls, 3)
  assert.equal(state.rolledBack, true)
  assert.equal(done.outcome, "rolled back")
  assert.equal(report.acceptance.failed[0].attempts, 3)
})

test("attempts default to ONE: a failing P0 is not retried unless it says so", async () => {
  let calls = 0
  await go({ acceptance: postSwap({ fulfil: async (o) => { calls++; return answer(o, [fail("acc:chat")]) } }) })
  assert.equal(calls, 1)
})

/* ── pre-swap-health ────────────────────────────────────────────────────── */

test("health runs after verify and BEFORE build — before the first thing that mutates", async () => {
  const state = newState()
  const { done, events } = await go({
    state, probe: { skill: false },
    acceptance: healthDecl({ fulfil: async (o) => { state.log.push("health"); return answer(o, [pass("health:login")]) } }),
  })
  assert.equal(done.outcome, "shipped")
  assert.equal(state.log[0], "health", `the first target call was ${state.log[0]}; the log was ${state.log.join(" > ")}`)
  assert.deepEqual(ran(events), ["verify", "health", "build", "swap", "prove", "sweep", "gate", "report"])
})

test("a failing health check REFUSES — nothing built, nothing swapped, nothing restarted, nothing to roll back", async () => {
  const { done, state, text, events, report } = await go({
    acceptance: healthDecl({ fulfil: async (o) => answer(o, [fail("health:login", "the identity provider is down")]) }),
  })
  assert.equal(done.outcome, "refused")
  assert.deepEqual(state.log, [], "not one call reached the target")
  assert.equal(state.rolledBack, false)
  assert.match(done.reason, /health:login/)
  assert.match(text, /nothing (was )?(built|mutated|touched)/i, "and the operator is told no rollback was needed")
  assert.ok(events.some((e) => e.kind === "step" && e.id === "health" && e.state === "fail"))
  assert.ok(events.filter((e) => e.kind === "step" && e.state === "run").every((e) => ["verify", "health"].includes(e.id)))
  assert.deepEqual(report.acceptance.failed.map((f) => f.id), ["health:login"])
})

test("before the swap even an UNREPORTED item refuses — 'could not see' is free there", async () => {
  const { done, state } = await go({ acceptance: healthDecl({ fulfil: async (o) => answer(o, []) }) })
  assert.equal(done.outcome, "refused")
  assert.deepEqual(state.log, [])
})

test("a base that is DOWN before the swap refuses at once — the fulfiller is not even asked, and cannot say PASS over it", async () => {
  const dead = http.createServer((_q, s) => { s.writeHead(503); s.end("down") })
  await new Promise((r) => dead.listen(0, "127.0.0.1", r))
  const deadBase = `http://127.0.0.1:${dead.address().port}`
  try {
    let asked = false
    const { done, state, text, report } = await go({
      base: deadBase,
      acceptance: healthDecl({ fulfil: async (o) => { asked = true; return answer(o, [pass("health:login")]) } }),
    })
    assert.equal(done.outcome, "refused")
    assert.equal(asked, false)
    assert.deepEqual(state.log, [])
    assert.match(text, /not serving/i)
    assert.match(done.reason, /liveness/)
    assert.equal(report.acceptance.failed.length, 1)
  } finally { dead.close() }
})

test("a P1 health failure warns and proceeds — severity means the same thing before the swap", async () => {
  const { done, text } = await go({
    acceptance: healthDecl({
      items: [{ id: "health:login", severity: "P0", judges: "health" }, { id: "health:cache", severity: "P1", judges: "health" }],
      fulfil: async (o) => answer(o, [pass("health:login"), fail("health:cache", "cold")]),
    }),
  })
  assert.equal(done.outcome, "shipped")
  assert.match(text, /warn: .*health:cache/)
})

test("a health check that hangs is cut off at its budget and REFUSES; the fulfiller is told to stop", async () => {
  let aborted = false
  const t0 = Date.now()
  const { done, state, text } = await go({
    acceptance: healthDecl({
      timeBudgetMs: 150,
      fulfil: (_o, { signal }) => new Promise((_res, rej) => { signal.addEventListener("abort", () => { aborted = true; rej(new Error("aborted")) }) }),
    }),
  })
  assert.ok(Date.now() - t0 < 4_000, "it must not wait for a fulfiller that never answers")
  assert.equal(done.outcome, "refused")
  assert.equal(aborted, true)
  assert.deepEqual(state.log, [])
  assert.match(text, /time budget|budget/i)
})

test("the health order says what it may not do, and is about the build being replaced", async () => {
  let seen
  await go({ acceptance: healthDecl({ fulfil: async (o) => { seen = o; return answer(o, [pass("health:login")]) } }) })
  assert.equal(seen.phase, "pre-swap-health")
  assert.equal(seen.healthOnly, true)
  assert.equal(seen.artifactId, "old-0", "the build being replaced — there is no new one yet")
  assert.match(seen.limits, /do not assert/i)
  assert.equal(seen.timeBudgetMs, 5_000)
})

/* ── refusals at wiring time ────────────────────────────────────────────── */

const refusedUntouched = (r, match) => {
  assert.equal(r.done.outcome, "refused")
  assert.match(r.done.reason, match)
  assert.deepEqual(r.state.log, [], `the target was touched: ${r.state.log.join(" > ")}`)
  assert.ok(!r.events.some((e) => e.kind === "step" && e.state === "run"), "not even verify ran")
}

test("pre-swap FUNCTIONAL acceptance is refused with SKILL-STEP's argument, before anything runs", async () => {
  let called = false
  const r = await go({
    acceptance: { phase: "pre-swap", items: [{ id: "acc:chat", severity: "P0" }], fulfil: async () => { called = true; return {} } },
  })
  refusedUntouched(r, /pre-swap|acceptance/)
  assert.match(r.text, /judges the build you are replacing/)
  assert.equal(called, false)
})

test("pre-swap-health that is not healthOnly is refused the same way", async () => {
  const r = await go({ acceptance: healthDecl({ healthOnly: false }) })
  refusedUntouched(r, /acceptance/)
  assert.match(r.text, /judges the build you are replacing/)
})

test("pre-swap-health with a behaviour item is refused even though it says healthOnly", async () => {
  const r = await go({ acceptance: healthDecl({ items: [{ id: "feature:export", severity: "P0", judges: "behaviour" }] }) })
  refusedUntouched(r, /acceptance/)
  assert.match(r.text, /feature:export/)
})

test("the staging exception: allowed, WARNED, and the order is addressed to staging", async () => {
  let seen
  const staging = BASE.replace("127.0.0.1", "localhost")
  const { done, text } = await go({
    acceptance: healthDecl({
      healthOnly: false, staging: { base: staging },
      items: [{ id: "feature:export", severity: "P0", judges: "behaviour" }],
      fulfil: async (o) => { seen = o; return answer(o, [pass("feature:export")]) },
    }),
  })
  assert.equal(done.outcome, "shipped")
  assert.match(text, /warn: .*staging/i)
  assert.equal(seen.base, staging, "judged against staging, not production")
})

test("staging that is the production base is not an exception", async () => {
  const r = await go({
    acceptance: healthDecl({ healthOnly: false, staging: { base: `${BASE}/` }, items: [{ id: "f", severity: "P0", judges: "behaviour" }] }),
  })
  refusedUntouched(r, /acceptance/)
})

test("an unknown phase is refused, naming the two that exist", async () => {
  const r = await go({ acceptance: postSwap({ phase: "after-everything" }) })
  refusedUntouched(r, /acceptance/)
  assert.match(r.text, /post-swap/)
  assert.match(r.text, /pre-swap-health/)
})

test("a missing severity is refused at wiring time — not defaulted, whichever way", async () => {
  const r = await go({ acceptance: postSwap({ items: [{ id: "acc:chat" }] }) })
  refusedUntouched(r, /acceptance/)
  assert.match(r.text, /acc:chat/)
  assert.match(r.text, /severity/)
})

test("health without healthOnly or a time budget is refused", async () => {
  for (const over of [{ healthOnly: undefined }, { timeBudgetMs: undefined }]) {
    const r = await go({ acceptance: healthDecl(over) })
    refusedUntouched(r, /acceptance/)
  }
})

/* ── where it is declared ───────────────────────────────────────────────── */

test("an adapter can declare acceptance too — and it is judged identically", async () => {
  const { done, state } = await go({
    targetAcceptance: postSwap({ fulfil: async (o) => answer(o, [fail("acc:chat")]) }),
  })
  assert.equal(state.rolledBack, true)
  assert.match(done.outcome, /rolled back/)
})

test("declared in BOTH places is refused — two gates, and nobody said which is the gate", async () => {
  const r = await go({ acceptance: postSwap(), targetAcceptance: postSwap() })
  refusedUntouched(r, /both|twice|two/i)
})

/* ── run everything, then decide: a plan with dependencies ─────────────── */

test("plan: a P0 red no longer stops an independent item — but its dependent is blocked, never asked, and named", async () => {
  const asked = []
  const { done, state, report } = await go({
    acceptance: postSwap({
      items: [
        { id: "acc:login", severity: "P0" },
        { id: "acc:search", severity: "P1" },
        { id: "acc:cart", severity: "P1", after: ["acc:login"] },
      ],
      fulfil: async (o) => { asked.push(...o.items.map((i) => i.id)); return answer(o, o.items.map((i) => (i.id === "acc:login" ? fail(i.id) : pass(i.id)))) },
    }),
  })
  assert.ok(asked.includes("acc:search"), "an independent P1 still runs after a P0 red")
  assert.ok(!asked.includes("acc:cart"), "a dependent of a red is not asked")
  assert.equal(state.rolledBack, true, "the decision comes after everything ran: P0 red → rollback")
  const by = Object.fromEntries(report.acceptance.plan.items.map((i) => [i.id, i]))
  assert.equal(by["acc:search"].status, "pass")
  assert.equal(by["acc:cart"].status, "blocked")
  assert.deepEqual(by["acc:cart"].blockedBy, ["acc:login"])
  assert.deepEqual(report.acceptance.plan.fixFirst, [{ id: "acc:login", blocks: 1 }])
  assert.match(done.reason, /acc:login/)
})

test("plan (the other half of the pair): when the prerequisite passes, the dependent IS asked, in a later round", async () => {
  const rounds = []
  const { done } = await go({
    acceptance: postSwap({
      items: [{ id: "acc:login", severity: "P0" }, { id: "acc:cart", severity: "P1", after: ["acc:login"] }],
      fulfil: async (o) => { rounds.push(o.items.map((i) => i.id)); return answer(o, o.items.map((i) => pass(i.id))) },
    }),
  })
  assert.deepEqual(rounds, [["acc:login"], ["acc:cart"]])
  assert.equal(done.outcome, "shipped")
})

test("plan: a P0 blocked by a failed P1 rolls back — an unverified P0 is not a pass", async () => {
  const { state, report } = await go({
    acceptance: postSwap({
      items: [{ id: "acc:seed", severity: "P1" }, { id: "acc:pay", severity: "P0", after: ["acc:seed"] }],
      fulfil: async (o) => answer(o, o.items.map((i) => (i.id === "acc:seed" ? fail(i.id) : pass(i.id)))),
    }),
  })
  assert.equal(state.rolledBack, true)
  assert.ok(report.acceptance.failed.some((f) => f.id === "acc:pay" && /blocked/.test(f.reason)))
})

test("plan: no `after` anywhere is one round over every item — exactly the old behaviour", async () => {
  const rounds = []
  await go({ acceptance: postSwap({ fulfil: async (o) => { rounds.push(o.items.map((i) => i.id)); return answer(o, o.items.map((i) => pass(i.id))) } }) })
  assert.deepEqual(rounds, [["acc:chat", "acc:export"]])
})

test("plan: a total budget — what is left when it runs out is reported not-run, and the decision proceeds", async () => {
  const rounds = []
  const { done, report, state } = await go({
    acceptance: postSwap({
      totalBudgetMs: 150,
      items: [{ id: "acc:a", severity: "P1" }, { id: "acc:b", severity: "P1", after: ["acc:a"] }],
      fulfil: async (o) => { rounds.push(o.items.map((i) => i.id)); await new Promise((r) => setTimeout(r, 250)); return answer(o, o.items.map((i) => pass(i.id))) },
    }),
  })
  assert.deepEqual(rounds, [["acc:a"]], "nothing is started after the budget is spent")
  const by = Object.fromEntries(report.acceptance.plan.items.map((i) => [i.id, i]))
  assert.equal(by["acc:b"].status, "not-run")
  assert.match(by["acc:b"].reason, /budget/)
  assert.equal(state.rolledBack, false, "a P1 that could not be run does not undo the deploy")
  assert.match(done.reason, /not run/)
})
