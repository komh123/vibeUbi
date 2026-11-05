import test from "node:test"
import assert from "node:assert/strict"
import {
  globMatches, compileGlobs, classifyFile, extractSurface, routeOf, authorIsOwn,
  computeGaps, gapsHash, ackVerdict, makeAck, draftFor, NARROWING_ACTIONS, requiresHuman,
} from "../src/index.mjs"

/* ── compileGlobs must be the SAME rule as globMatches ─────────────────── */

test("compileGlobs and globMatches agree on every case (one rule, two entry points)", () => {
  const patterns = [
    ["components/**"], ["app/**/page.tsx"], ["lib/*.ts"], ["**/__tests__/**"], ["!docs/**", "**"], ["a?c.js"],
    ["messages/*.json", "!messages/en.json"], [], ["*.md"], ["app/api/agent*/**"],
  ]
  const files = ["components/a/b.tsx", "app/page.tsx", "app/x/y/page.tsx", "lib/a.ts", "lib/x/a.ts", "x/__tests__/a.ts", "docs/a.md",
    "abc.js", "messages/en.json", "messages/fr.json", "README.md", "app/api/agent-next/x.ts", "app/api/agents/x/y.ts", "a/b.md"]
  let discriminating = 0
  for (const p of patterns) for (const f of files) {
    assert.equal(compileGlobs(p)(f), globMatches(f, p), `${p.join(",")} on ${f}`)
    if (globMatches(f, p)) discriminating++
  }
  assert.ok(discriminating > 10, "the corpus must contain matches, or equality proves nothing")
})

/* ── classifier ────────────────────────────────────────────────────────── */

test("default classifier: Next.js app router, components, libs, tests, docs, config", () => {
  const cases = {
    "app/[locale]/(app)/foo/page.tsx": "page",
    "app/layout.tsx": "page",
    "app/api/agent-next/file/route.ts": "api",
    "app/robots/route.ts": "route",
    "pages/api/hello.ts": "api",
    "pages/about.tsx": "page",
    "routes/users.js": "api",
    "components/agent-next/status-band.tsx": "component",
    "src/widgets/Card.tsx": "component",
    "lib/agent-next/agent-handoff.ts": "lib",
    "components/agent-next/__tests__/status-band.test.tsx": "test",
    "lib/a.test.ts": "test",
    "e2e/login.spec.ts": "test",
    "docs/ship/x.md": "docs",
    "README.md": "docs",
    "package.json": "config",
    "next.config.ts": "config",
    "messages/en.json": "config",
    "Dockerfile": "config",
    "assets/logo.png": "other",
  }
  for (const [file, want] of Object.entries(cases)) assert.equal(classifyFile(file), want, file)
})

test("a project rule beats the default, and a classify function beats a rule", () => {
  const rules = [{ class: "page", match: ["content/help/*.json"] }]
  assert.equal(classifyFile("content/help/design-mode.json", { rules }), "page")
  assert.equal(classifyFile("content/help/design-mode.json"), "config", "without the rule it is data")
  assert.equal(classifyFile("lib/x.ts", { rules, classify: (f, d) => (f === "lib/x.ts" ? "api" : undefined) }), "api")
  assert.equal(classifyFile("lib/y.ts", { classify: () => undefined }), "lib", "undefined falls through")
  assert.equal(classifyFile("components/a.tsx", { rules, replace: true }), "other", "replace drops the defaults")
})

/* ── surface extraction ───────────────────────────────────────────────── */

test("routeOf: app router drops groups and slots, keeps static prefix", () => {
  assert.equal(routeOf("app/[locale]/(app)/foo/bar/page.tsx"), "/[locale]/foo/bar")
  assert.equal(routeOf("app/api/agent-next/file/route.ts"), "/api/agent-next/file")
  assert.equal(routeOf("app/page.tsx"), "/")
  assert.equal(routeOf("pages/a/index.tsx"), "/a")
  assert.equal(routeOf("components/a.tsx"), null)
})

test("extractSurface pulls selectors, methods, exports and api calls out of text", () => {
  const src = `
    export function StatusBand() { return <div data-testid="status-band" aria-label="Task status"><b data-testid={'inner'} /><i data-testid={\`row-\${id}\`} /></div> }
    export const UndoToast = () => null
    export const RANGE_TONE = 3
    export default function Page() {}
    export async function GET(req) {}
    export const POST = async () => {}
    fetch("/api/agent-next/undo", { method: "POST" })
    const helper = 1; export function helperFn() {}
  `
  const s = extractSurface(src, { file: "components/x.tsx", class: "component" })
  assert.deepEqual(s.testIds, ["inner", "status-band"], "dynamic ids are not extracted")
  assert.deepEqual(s.ariaLabels, ["Task status"])
  assert.deepEqual(s.exports, ["Page", "StatusBand", "UndoToast"], "capitalised component-looking exports; helperFn and the HTTP method names are not components")
  assert.deepEqual(s.httpMethods, ["GET", "POST"])
  assert.deepEqual(s.apiCalls, ["/api/agent-next/undo"])
})

/* ── authors ──────────────────────────────────────────────────────────── */

test("authorIsOwn: exact name or email, glob on the full string, RegExp; nothing configured means nobody is ours", () => {
  const colleague = { name: "Ubuntu", email: "ubuntu@ip-172-31-6-187.netbird.cloud" }
  const us = { name: "AI Agent System", email: "agent@example.com" }
  assert.equal(authorIsOwn(us, ["agent@example.com"]), true)
  assert.equal(authorIsOwn(us, ["AI Agent System"]), true)
  assert.equal(authorIsOwn(colleague, ["agent@example.com"]), false)
  assert.equal(authorIsOwn(colleague, ["*@ip-172-31-*.netbird.cloud>"]), true)
  assert.equal(authorIsOwn(colleague, [/netbird\.cloud/]), true)
  assert.equal(authorIsOwn({ name: "xagent", email: "xagent@example.com.evil" }, ["agent@example.com"]), false, "no substring match without a wildcard")
  assert.equal(authorIsOwn(us, []), false)
})

/* ── gaps ─────────────────────────────────────────────────────────────── */

const TRACKED = [
  ...Array.from({ length: 60 }, (_, i) => `components/agent-next/c${i}.tsx`),
  "components/agent-next/panel/team-a.tsx", "components/agent-next/panel/team-b.tsx",
  "app/api/agent-next/file/route.ts", "scripts/acceptance/evidence.mjs",
  ...Array.from({ length: 40 }, (_, i) => `app/api/x${i}/route.ts`),
]
const CLAIMS = [
  { id: "chat", covers: ["components/**", "app/api/**"] },
  { id: "team", covers: ["components/agent-next/panel/team-*"] },
]
const base = { claims: CLAIMS, tracked: TRACKED, evidence: [{ path: "scripts/acceptance/evidence.mjs", text: "await page.click('[data-testid=\"old-thing\"]')" }], ownAuthors: ["agent@example.com"] }
const us = { name: "AI Agent System", email: "agent@example.com" }
const them = { name: "Ubuntu", email: "u@x" }

test("docs, tests and config changes are never gaps", () => {
  const r = computeGaps({ ...base, files: [
    { path: "docs/a.md", status: "A", addedText: "# x" },
    { path: "components/agent-next/__tests__/a.test.tsx", status: "A", addedText: "x" },
    { path: "package.json", status: "M", addedText: "" },
  ], authorsByFile: {} })
  assert.deepEqual(r.gaps, [])
  assert.equal(r.stats.exempt, 3)
})

test("an unclaimed file is a gap; foreign authorship makes it red, ours makes it warn", () => {
  const files = [{ path: "lib/brand-new/thing.ts", status: "M", addedText: "export const x = 1" }]
  const red = computeGaps({ ...base, files, authorsByFile: { "lib/brand-new/thing.ts": [them] } })
  assert.equal(red.gaps.length, 1)
  assert.equal(red.gaps[0].kind, "unclaimed")
  assert.equal(red.gaps[0].severity, "red")
  const warn = computeGaps({ ...base, files, authorsByFile: { "lib/brand-new/thing.ts": [us] } })
  assert.equal(warn.gaps[0].severity, "warn")
  const mixed = computeGaps({ ...base, files, authorsByFile: { "lib/brand-new/thing.ts": [us, them] } })
  assert.equal(mixed.gaps[0].severity, "red", "any foreign commit makes it foreign")
  const unknown = computeGaps({ ...base, files, authorsByFile: {} })
  assert.equal(unknown.gaps[0].severity, "red", "no known author is not ours")
})

test("FALSIFIABLE PAIR: a wide glob contains a NEW component; with no script mentioning it, it is a gap; mention it and it is covered", () => {
  const files = [{ path: "components/agent-next/status-band.tsx", status: "A", addedText: `export function StatusBand(){ return <div data-testid="status-band"/> }` }]
  const gap = computeGaps({ ...base, files, authorsByFile: { "components/agent-next/status-band.tsx": [them] } })
  assert.equal(gap.gaps.length, 1)
  assert.equal(gap.gaps[0].kind, "new-surface")
  assert.equal(gap.gaps[0].specificClaim, false)
  assert.deepEqual(gap.gaps[0].claimedBy.map((c) => c.id), ["chat"], "it IS claimed, by a wide glob")
  assert.deepEqual(gap.gaps[0].claimedBy[0].ids, ["chat"])
  assert.equal(gap.gaps[0].claimedBy[0].breadth > 25, true)

  const mentioned = computeGaps({
    ...base, files, authorsByFile: { "components/agent-next/status-band.tsx": [them] },
    evidence: [{ path: "scripts/acceptance/new.mjs", text: `await page.locator('[data-testid="status-band"]').waitFor()` }],
  })
  assert.deepEqual(mentioned.gaps, [])
  assert.equal(mentioned.stats.exercisedByMention, 1)
})

test("the same wide glob declared by many claims is ONE claimedBy entry listing them", () => {
  const files = [{ path: "components/agent-next/status-band.tsx", status: "A", addedText: "export function StatusBand(){}" }]
  const claims = Array.from({ length: 30 }, (_, i) => ({ id: `item-${i}`, covers: ["components/**"] }))
  const r = computeGaps({ ...base, claims, files, authorsByFile: {} })
  assert.equal(r.gaps[0].claimedBy.length, 1)
  assert.equal(r.gaps[0].claimedBy[0].ids.length, 30)
})

test("a mention must respect token boundaries (status-band must not satisfy status-bandit)", () => {
  const files = [{ path: "components/agent-next/status-band.tsx", status: "A", addedText: `<i data-testid="status-band"/>` }]
  const r = computeGaps({ ...base, files, authorsByFile: {}, evidence: [{ path: "e.mjs", text: "data-testid=status-bandit" }] })
  assert.equal(r.gaps.length, 1)
})

test("a narrow claim exercises a new surface (no text needed)", () => {
  const files = [{ path: "components/agent-next/panel/team-c.tsx", status: "A", addedText: "export function TeamC(){}" }]
  const r = computeGaps({ ...base, tracked: [...TRACKED, "components/agent-next/panel/team-c.tsx"], files, authorsByFile: {} })
  assert.deepEqual(r.gaps, [])
})

test("a modified, already-covered file with no new surface is not a gap", () => {
  const files = [{ path: "components/agent-next/c3.tsx", status: "M", addedText: "const a = 2" }]
  assert.deepEqual(computeGaps({ ...base, files, authorsByFile: {} }).gaps, [])
})

test("a modified file whose added lines introduce a new data-testid is a new-surface gap, and an old one is not", () => {
  const fresh = [{ path: "components/agent-next/c3.tsx", status: "M", addedText: `<b data-testid="undo-toast"/>` }]
  const r = computeGaps({ ...base, files: fresh, authorsByFile: {} })
  assert.equal(r.gaps[0].kind, "new-surface")
  assert.deepEqual(r.gaps[0].surface.testIds, ["undo-toast"])
  const old = [{ path: "components/agent-next/c3.tsx", status: "M", addedText: `<b data-testid="old-thing"/>` }]
  assert.deepEqual(computeGaps({ ...base, files: old, authorsByFile: {} }).gaps, [])
})

test("a new route is a gap with its method and path; a pure rename is not", () => {
  const route = [{ path: "app/api/agent-next/undo/route.ts", status: "A", addedText: "export async function POST(){}" }]
  const r = computeGaps({ ...base, files: route, authorsByFile: {} })
  assert.equal(r.gaps[0].class, "api")
  assert.equal(r.gaps[0].route, "/api/agent-next/undo")
  assert.deepEqual(r.gaps[0].surface.httpMethods, ["POST"])
  const renamed = [{ path: "components/agent-next/c9.tsx", oldPath: "components/agent-next/c3.tsx", status: "R", addedText: "" }]
  assert.deepEqual(computeGaps({ ...base, files: renamed, authorsByFile: {} }).gaps, [])
})

test("ignored globs and exemptClasses are honoured; deleted files are skipped", () => {
  const files = [{ path: "work/scratch.ts", status: "A", addedText: "x" }, { path: "lib/gone.ts", status: "D", addedText: "" }]
  assert.deepEqual(computeGaps({ ...base, ignored: ["work/**"], files, authorsByFile: {} }).gaps, [])
  const lib = [{ path: "lib/a.ts", status: "A", addedText: "x" }]
  assert.equal(computeGaps({ ...base, files: lib, authorsByFile: {} }).gaps.length, 1)
  assert.deepEqual(computeGaps({ ...base, exemptClasses: ["lib", "docs", "test", "config"], files: lib, authorsByFile: {} }).gaps, [])
})

/* ── ack ──────────────────────────────────────────────────────────────── */

test("gapsHash ignores order and time; it changes with kind, path, blob and author bucket", () => {
  const g = (o) => ({ kind: "unclaimed", path: "a.ts", blob: "b1", severity: "red", ...o })
  const h = gapsHash([g({}), g({ path: "b.ts" })])
  assert.equal(h, gapsHash([g({ path: "b.ts" }), g({})]))
  assert.notEqual(h, gapsHash([g({})]))
  assert.notEqual(gapsHash([g({})]), gapsHash([g({ blob: "b2" })]))
  assert.notEqual(gapsHash([g({})]), gapsHash([g({ kind: "new-surface" })]))
  assert.notEqual(gapsHash([g({})]), gapsHash([g({ severity: "warn" })]))
  assert.match(h, /^[0-9a-f]{64}$/)
})

test("ackVerdict: none, valid, and stale with the difference spelled out", () => {
  const gaps = [{ kind: "unclaimed", path: "a.ts", blob: "1", severity: "red" }]
  assert.equal(ackVerdict({ acks: [], gaps }).status, "none")
  const ack = makeAck({ gaps, by: "roy", note: "ok", at: "2026-11-05T00:00:00Z", base: "b", head: "h" })
  assert.deepEqual(ack.items, [{ key: "unclaimed:a.ts", blob: "1" }])
  assert.equal(ack.gapsHash, gapsHash(gaps))
  const ok = ackVerdict({ acks: [ack], gaps })
  assert.equal(ok.status, "valid")
  assert.equal(ok.ack.by, "roy")
  const more = [...gaps, { kind: "new-surface", path: "b.tsx", blob: "2", severity: "red" }]
  const stale = ackVerdict({ acks: [ack], gaps: more })
  assert.equal(stale.status, "stale")
  assert.deepEqual(stale.added, ["new-surface:b.tsx"])
  assert.deepEqual(stale.removed, [])
  assert.equal(ackVerdict({ acks: [ack], gaps: [] }).status, "none", "no gaps: nothing to acknowledge")
  const edited = ackVerdict({ acks: [ack], gaps: [{ ...gaps[0], blob: "9" }] })
  assert.equal(edited.status, "stale", "the same path with different bytes is not what the human saw")
  assert.deepEqual(edited.changed, ["unclaimed:a.ts"])
})

test("coverage-ack is a narrowing action: an agent must not do it unasked", () => {
  assert.ok(NARROWING_ACTIONS.includes("coverage-ack"))
  assert.equal(requiresHuman("coverage-ack"), true)
})

/* ── drafts ───────────────────────────────────────────────────────────── */

const gapFor = () => computeGaps({
  ...base, authorsByFile: { "components/agent-next/status-band.tsx": [them] },
  files: [{ path: "components/agent-next/status-band.tsx", status: "A", addedText: `export function StatusBand(){ return <div data-testid="status-band" aria-label="Status"/> }` }],
}).gaps[0]

test("draftFor fills the template with selector suggestions and is a syntactically sane record() skeleton", () => {
  const d = draftFor({ ...gapFor(), commits: [{ sha: "abcdef0123", author: "Ubuntu", subject: "feat(composer): 狀態帶" }] })
  assert.match(d.id, /^status-band/)
  assert.equal(d.fileName, `${d.id}.mjs`)
  assert.match(d.source, /record\(/)
  assert.match(d.source, /data-testid="status-band"/)
  assert.match(d.source, /TODO/)
  assert.match(d.source, /abcdef0/)
  assert.deepEqual(d.covers, ["components/agent-next/status-band.tsx"])
})

test("draftFor honours a project template by class, and unknown placeholders throw", () => {
  const d = draftFor(gapFor(), { default: "// {{id}} for {{file}} ({{class}})", component: "// component {{id}}\n{{selectors}}" })
  assert.match(d.source, /^\/\/ component status-band/)
  assert.throws(() => draftFor(gapFor(), "{{nope}}"), /unknown placeholder.*nope/)
  assert.equal(draftFor(gapFor(), "plain {{id}}").source, "plain status-band")
})
