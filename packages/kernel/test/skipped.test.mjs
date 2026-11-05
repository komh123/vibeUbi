/**
 * An optional, first-class `skipped` status.
 *
 * A step that cannot run because of the environment (a permission the owner has
 * not fixed, a site that is not provisioned) is neither a pass nor a fault in
 * the change. Consumers encoded it as `unchanged` plus a reason prefix and had
 * every report reader parse the prefix. This makes it a status, with two hard
 * rules: it is OPT-IN (nothing that worked before changes), and it is NEVER
 * evidence.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { planOutcome, countsAsEvidence, readyToRun, PLAN_STATUSES, OPTIONAL_PLAN_STATUSES } from "../src/index.mjs"

const HERE = dirname(fileURLToPath(import.meta.url))
const before = JSON.parse(await readFile(join(HERE, "fixtures/pre-skipped-behaviour.json"), "utf8"))

test("backward compatibility: every recorded pre-change input yields byte-identical results", () => {
  for (const [name, results] of Object.entries(before.plans)) {
    assert.deepEqual(planOutcome(before.items, results), before.expected.planOutcome[name], `planOutcome ${name}`)
  }
  assert.deepEqual(planOutcome([], {}), before.expected.planOutcome.noItems)
  for (const [name, [report, want]] of Object.entries(before.reports)) {
    assert.deepEqual(countsAsEvidence(report, want), before.expected.countsAsEvidence[name], `countsAsEvidence ${name}`)
  }
})

test("PLAN_STATUSES is untouched; the new status is a separate, named opt-in set", () => {
  assert.deepEqual([...PLAN_STATUSES], ["pass", "fail", "blocked", "not-run"])
  assert.deepEqual([...OPTIONAL_PLAN_STATUSES], ["skipped"])
  assert.equal(Object.isFrozen(OPTIONAL_PLAN_STATUSES), true)
})

test("without the opt-in, a 'skipped' result is exactly as unknown as it was (the recorded case)", () => {
  const r = planOutcome(before.items, before.plans.skippedWithoutOptIn)
  assert.notEqual(r.items.find((i) => i.id === "a").status, "skipped")
})

const items = [{ id: "login" }, { id: "checkout", after: ["login"] }, { id: "ship", after: ["checkout"] }, { id: "search" }]
const results = {
  login: { status: "skipped", category: "environment-blocked", reason: "FUSE write denied (ISS-0365)" },
  search: "pass",
}

test("opt-in: a skipped item is its own status with category and reason", () => {
  const out = planOutcome(items, results, { skipped: true })
  assert.deepEqual(out.items.find((i) => i.id === "login"), {
    id: "login", status: "skipped", category: "environment-blocked", reason: "FUSE write denied (ISS-0365)",
  })
  assert.deepEqual(out.skipped, ["login"])
})

test("opt-in: dependents of a skipped item are blocked by it, never run, never failed", () => {
  const out = planOutcome(items, results, { skipped: true })
  assert.deepEqual(out.items.find((i) => i.id === "checkout"), { id: "checkout", status: "blocked", blockedBy: ["login"] })
  assert.deepEqual(out.items.find((i) => i.id === "ship").blockedBy, ["login"])
  assert.deepEqual(out.deferred, ["checkout", "ship"])
  assert.deepEqual(out.fixFirst, [], "an environment block is not a failure to fix in the change")
  assert.equal(readyToRun({ id: "checkout", after: ["login"] }, { login: { status: "skipped" } }), false)
})

test("opt-in: a skipped item makes the round unclean and the headline says so", () => {
  const out = planOutcome(items, results, { skipped: true })
  assert.equal(out.clean, false)
  assert.match(out.headline, /1 skipped/)
  assert.match(out.headline, /2 blocked/)
  // all other items passing does not rescue it
  const onlyOne = planOutcome([{ id: "x" }, { id: "y" }], { x: "pass", y: { status: "skipped", reason: "no site" } }, { skipped: true })
  assert.equal(onlyOne.clean, false)
})

test("opt-in: category is optional, and reason alone is enough", () => {
  const out = planOutcome([{ id: "x" }], { x: { status: "skipped", reason: "no site" } }, { skipped: true })
  assert.deepEqual(out.items[0], { id: "x", status: "skipped", reason: "no site" })
})

test("opt-in leaves everything that has no skipped item byte-identical (shape included)", () => {
  for (const [name, results] of Object.entries(before.plans)) {
    if (name === "skippedWithoutOptIn") continue
    assert.deepEqual(planOutcome(before.items, results, { skipped: true }), before.expected.planOutcome[name], name)
  }
})

test("countsAsEvidence: any skipped step refuses the report, whichever shape carries it", () => {
  const want = {}
  const row = { status: "skipped", reason: "env" }
  const shapes = {
    stepsObject: { ok: true, steps: { a: { status: "pass" }, b: row } },
    stepsArray: { ok: true, steps: [{ name: "a", status: "pass" }, { name: "b", ...row }] },
    outcomeItems: { ok: true, outcome: { items: [{ id: "a", status: "pass" }, { id: "b", ...row }] } },
  }
  for (const [name, report] of Object.entries(shapes)) {
    const v = countsAsEvidence(report, want)
    assert.equal(v.ok, false, name)
    assert.match(v.reason, /skipped/, name)
  }
  // the falsifiable twin: the same reports without the skipped row are accepted
  assert.equal(countsAsEvidence({ ok: true, steps: { a: { status: "pass" } } }, want).ok, true)
  assert.equal(countsAsEvidence({ ok: true, steps: [{ name: "a", status: "pass" }] }, want).ok, true)
  assert.equal(countsAsEvidence({ ok: true, outcome: { items: [{ id: "a", status: "pass" }] } }, want).ok, true)
})

test("countsAsEvidence: a coverage-style `skipped` list (other reports' field) is not mistaken for the status", () => {
  assert.equal(countsAsEvidence({ ok: true, skipped: ["S3 — needs base"] }).ok, true)
})
