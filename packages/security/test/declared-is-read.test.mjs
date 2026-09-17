/**
 * The registry only works if what people write into it is consumed.
 *
 * Every test here exists because the same defect happened three times in one
 * week: a field was declared, reviewed, believed, and read by nothing.
 *   - the gate ignored `priority`, and a ship went green over 61 ungated routes
 *   - S2 ignored `requiredRole`, and flagged the LOGIN endpoints for not being
 *     behind the login gate
 *   - `declaredFieldsAreRead`, the check written to catch exactly this, had
 *     zero call sites for its entire life
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync, readdirSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { s2Routes, s4Exposure } from "../src/rules.mjs"
import { declaredFieldsAreRead, READ_DECLARED_FIELDS } from "../../kernel/src/index.mjs"

const REPO = join(dirname(fileURLToPath(import.meta.url)), "../../..")
const sources = () => {
  const out = []
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name.startsWith(".") || e.name === "test") continue
      const p = join(d, e.name)
      e.isDirectory() ? walk(p) : e.name.endsWith(".mjs") && out.push([p, readFileSync(p, "utf8")])
    }
  }
  walk(join(REPO, "packages")); walk(join(REPO, "bin"))
  return out
}

const GATED = { path: "/api/kill", methods: ["POST"], body: "verifyToken(req)", source: "a.js" }
const OPEN = { path: "/api/kill", methods: ["POST"], body: "", source: "a.js" }
const TOKENS = ["verifyToken"]

test("a route declared reachable by a guest is not reported as undeclared", () => {
  const out = s2Routes({ routes: [OPEN], gateTokens: TOKENS,
    declared: [{ id: "api:/api/kill", requiredRole: "guest" }] })
  assert.equal(out.filter((f) => f.rule === "S2.route.ungated").length, 0)
  const asked = out.find((f) => f.rule === "S2.route.public_no_reason")
  assert.ok(asked, "it should still ask for the reason")
  assert.equal(asked.severity, "medium")
})

test("guest narrows the question, it does not clear the route", () => {
  // The whole risk of reading `requiredRole` is that it becomes a silencer.
  const out = s2Routes({ routes: [OPEN], gateTokens: TOKENS,
    declared: [{ id: "api:/api/kill", requiredRole: "guest" }] })
  assert.equal(out.length, 1, "a guest route still produces a finding")
})

test("a route with no declaration at all is still HIGH", () => {
  const out = s2Routes({ routes: [OPEN], gateTokens: TOKENS, declared: [] })
  assert.equal(out[0].rule, "S2.route.ungated")
  assert.equal(out[0].severity, "high")
})

test("a user/admin route declared is still HIGH — declaring it does not gate it", () => {
  for (const role of ["user", "admin"]) {
    const out = s2Routes({ routes: [OPEN], gateTokens: TOKENS, declared: [{ id: "api:/api/kill", requiredRole: role }] })
    assert.equal(out[0].rule, "S2.route.ungated", `requiredRole ${role} must not silence anything`)
    assert.equal(out[0].severity, "high")
  }
})

test("an allow-list entry WITH a reason still clears the route entirely", () => {
  const out = s2Routes({ routes: [OPEN], gateTokens: TOKENS,
    publicApi: [{ id: "api:/api/kill", reason: "webhook, signature-verified" }],
    declared: [{ id: "api:/api/kill", requiredRole: "guest" }] })
  assert.deepEqual(out, [])
})

test("a gated route is clear regardless of what the declaration says", () => {
  assert.deepEqual(s2Routes({ routes: [GATED], gateTokens: TOKENS, declared: [{ id: "api:/api/kill", requiredRole: "guest" }] }), [])
})

test("a listener this scan cannot see is unmeasured, not stale", () => {
  const declared = [{ service: "k8s/app", port: 80 }]
  const blind = s4Exposure({ listeners: [], declared, canObserve: false })
  assert.equal(blind[0].rule, "S4.exposure.unobservable")
  assert.equal(blind[0].severity, "info")
  const looked = s4Exposure({ listeners: [], declared, canObserve: true })
  assert.equal(looked[0].rule, "S4.exposure.stale")
})

test("READ_DECLARED_FIELDS is honest — every field it claims has a consumer", () => {
  const src = sources()
  for (const field of Object.keys(READ_DECLARED_FIELDS)) {
    const hit = src.some(([p, t]) =>
      !p.includes("/kernel/src/admission.mjs") &&
      (t.includes(`.${field}`) || t.includes(`"${field}"`) || t.includes(`'${field}'`)))
    assert.ok(hit, `READ_DECLARED_FIELDS claims "${field}" is consumed, but nothing outside the list mentions it`)
  }
})

test("the unread-field check is actually WIRED — it had zero call sites for its whole life", () => {
  const callers = sources().filter(([p, t]) =>
    !p.endsWith("admission.mjs") && !p.endsWith("index.mjs") && /declaredFieldsAreRead\s*\(/.test(t))
  assert.ok(callers.length > 0,
    "declaredFieldsAreRead is exported and tested but called by nothing — it is an instance of the defect it detects")
})

test("a field nobody consumes is reported, whatever it is called", () => {
  // This test used to assert that `testId` and `probes` were unread, which was
  // TRUE — adopt wrote them for every P0 page and nothing executed them. That
  // was the finding this guard surfaced on the day it was first wired. The
  // probe step is now their consumer, so that instance is gone and the test
  // went red, correctly. Pinned to the MECHANISM instead of to one instance,
  // which is what it should have been.
  const declared = [{ id: "page:/login", kind: "page", priority: "P0", inventedByNobody: 1 }]
  const r = declaredFieldsAreRead(declared, Object.keys(READ_DECLARED_FIELDS))
  assert.equal(r.ok, false)
  assert.deepEqual(r.unread, ["inventedByNobody"])
  assert.match(r.reason, /looks like a control and is a decoration/)
})

test("and the fields that DO have a consumer are silent", () => {
  const declared = [{ id: "page:/login", kind: "page", priority: "P0", testId: "app-page-login", probes: [{}] }]
  assert.equal(declaredFieldsAreRead(declared, Object.keys(READ_DECLARED_FIELDS)).ok, true,
    "testId/probes are consumed by probeOrder now — if this goes red, the probe step stopped carrying them")
})

/* ── coverage ─────────────────────────────────────────────────────────────
 * A scan that looked at nothing must not score like a scan that looked and
 * found nothing. Measured before the fix, on a project whose stack no adapter
 * recognises and which contains an ungated POST /api/admin/delete_everything:
 * grade A, score 100, counts "clean", 0 findings.
 */
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { grade, coverageOf } from "../../kernel/src/index.mjs"
import { runScan } from "../src/run.mjs"

test("no grade is issued when a requested check never ran", () => {
  const g = grade([], ["S2.route.ungated — no api routes discovered"])
  assert.equal(g.grade, "—")
  assert.equal(g.score, null, "a number here is the whole bug — it gets believed")
  assert.match(g.reason, /never ran/)
})

test("a fully measured clean scan still grades A", () => {
  assert.equal(grade([], []).grade, "A")
  assert.equal(grade([{ severity: "critical" }, { severity: "critical" }, { severity: "critical" }, { severity: "critical" }], []).grade, "F")
})

test("F is withheld too — claiming a bad score you did not measure is the same lie", () => {
  const g = grade([{ severity: "critical" }, { severity: "critical" }, { severity: "critical" }, { severity: "critical" }],
                  ["S2 — nothing discovered"])
  assert.equal(g.grade, "—")
})

test("a layer skipped BY CHOICE is not counted against coverage", () => {
  const c = coverageOf({ layers: ["S0"], skipped: ["S3 DAST — not requested"] })
  assert.equal(c.ok, true)
  assert.equal(coverageOf({ layers: ["S2"], skipped: ["S2 — no api routes discovered"] }).ok, false)
})

test("an unrecognised stack cannot come back clean", async () => {
  const root = await mkdtemp(join(tmpdir(), "vibeubi-blind-"))
  try {
    await mkdir(join(root, "src"), { recursive: true })
    await writeFile(join(root, "package.json"), '{"name":"unknown-stack"}', "utf8")
    // A real, dangerous, completely ungated route — in a language no adapter reads.
    await writeFile(join(root, "src/server.py"),
      '@app.route("/api/admin/delete_everything", methods=["POST"])\ndef nuke(): return do_it()\n', "utf8")
    const r = await runScan({ root, config: {}, layers: ["S0", "S2", "S4"], discovered: [] })
    assert.equal(r.grade.grade, "—", `graded ${r.grade.grade} over a scan that discovered nothing`)
    assert.ok(r.blocking.length > 0, "an unmeasured requested check must block, not pass quietly")
    assert.notEqual(r.counts, "clean")
  } finally { await rm(root, { recursive: true, force: true }) }
})
