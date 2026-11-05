/**
 * The git half of coverage-gap, against REAL temporary repositories: a base commit by us, then a teammate's commits
 * (new route, new component, a change to an already-covered file, a docs change) and one of ours.
 */
import test from "node:test"
import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { commitsSince, runCoverageGap, readAcks, writeAck, gateOutcome, renderMarkdown } from "../src/coverage-gap.mjs"

const BIN = join(dirname(fileURLToPath(import.meta.url)), "../../../bin/vibeubi.mjs")
const US = { name: "AI Agent System", email: "agent@example.com" }
const THEM = { name: "Ubuntu", email: "ubuntu@ip-172-31-6-187.netbird.cloud" }

class Repo {
  constructor(dir) { this.dir = dir }
  git(args, author = US) {
    return execFileSync("git", args, {
      cwd: this.dir, encoding: "utf8",
      env: { ...process.env, GIT_AUTHOR_NAME: author.name, GIT_AUTHOR_EMAIL: author.email, GIT_COMMITTER_NAME: author.name, GIT_COMMITTER_EMAIL: author.email },
    }).trim()
  }
  async write(path, text) { await mkdir(dirname(join(this.dir, path)), { recursive: true }); await writeFile(join(this.dir, path), text) }
  async commit(files, author, message) {
    for (const [p, t] of Object.entries(files)) await this.write(p, t)
    this.git(["add", "-A"], author)
    this.git(["commit", "-q", "-m", message], author)
    return this.git(["rev-parse", "HEAD"])
  }
}

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "vibeubi-cg-"))
  const repo = new Repo(dir)
  repo.git(["init", "-q", "-b", "main"])
  const seed = {}
  for (let i = 0; i < 30; i++) seed[`components/agent-next/c${i}.tsx`] = `export function C${i}() { return <i data-testid="old-thing-${i}" /> }\n`
  for (let i = 0; i < 30; i++) seed[`app/api/seed${i}/route.ts`] = `export async function GET() {}\n`
  seed["scripts/acceptance/accept.mjs"] = "record('old', async () => { await page.click('[data-testid=\"old-thing-1\"]') })\n"
  seed["docs/readme.md"] = "# docs\n"
  const base = await repo.commit(seed, US, "chore: seed")
  return { repo, dir, base, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

const CONFIG = {
  ownAuthors: ["agent@example.com"],
  claims: [{ id: "chat", covers: ["components/**", "app/api/**"] }, { id: "accept", selfPaths: ["scripts/acceptance/**"] }],
  evidence: ["scripts/acceptance/**"],
  ignored: [],
}

async function colleagueBatch(repo) {
  await repo.commit({ "app/api/undo/route.ts": "export async function POST() {}\n" }, THEM, "feat(api): undo endpoint")
  await repo.commit({ "components/agent-next/status-band.tsx": "export function StatusBand() { return <div data-testid=\"status-band\" aria-label=\"Status\" /> }\n" }, THEM, "feat(composer): status band")
  await repo.commit({ "components/agent-next/c3.tsx": "export function C3() { return <i data-testid=\"old-thing-3\" /> }\n// tweak\n" }, THEM, "fix: tweak c3")
  await repo.commit({ "docs/readme.md": "# docs\nmore\n" }, THEM, "docs: more")
}

test("commitsSince lists the range with authors, own flag and files; a merge is listed and its branch commits are expanded", async () => {
  const { repo, base, cleanup } = await fixture()
  try {
    repo.git(["checkout", "-q", "-b", "feature"])
    await repo.commit({ "components/agent-next/f1.tsx": "export function F1() {}\n" }, THEM, "feat: f1")
    repo.git(["checkout", "-q", "main"])
    await repo.commit({ "lib/ours.ts": "export const x = 1\n" }, US, "feat: ours")
    repo.git(["merge", "-q", "--no-ff", "-m", "Merge feature", "feature"], US)
    const commits = await commitsSince(base, "HEAD", { root: repo.dir, ownAuthors: ["agent@example.com"] })
    assert.equal(commits.length, 3, "feature commit, ours, and the merge")
    const merge = commits.find((c) => c.isMerge)
    assert.ok(merge && merge.subject === "Merge feature" && merge.own === true)
    assert.deepEqual(merge.files, [], "a merge commit owns no files; its branch commits do")
    const f1 = commits.find((c) => c.subject === "feat: f1")
    assert.equal(f1.own, false)
    assert.deepEqual(f1.files.map((f) => `${f.status} ${f.path}`), ["A components/agent-next/f1.tsx"])
    assert.equal(f1.author.email, THEM.email)
    assert.equal(commits.find((c) => c.subject === "feat: ours").own, true)
  } finally { await cleanup() }
})

test("the teammate's batch: new route and new component are red gaps; a covered-file tweak and a docs change are not", async () => {
  const { repo, base, cleanup } = await fixture()
  try {
    await colleagueBatch(repo)
    const report = await runCoverageGap({ root: repo.dir, config: { coverageGap: CONFIG }, base })
    const keys = report.gaps.map((g) => `${g.severity} ${g.kind} ${g.path}`)
    assert.deepEqual(keys.sort(), [
      "red new-surface app/api/undo/route.ts",
      "red new-surface components/agent-next/status-band.tsx",
    ])
    const band = report.gaps.find((g) => g.path.endsWith("status-band.tsx"))
    assert.deepEqual(band.surface.testIds, ["status-band"])
    assert.equal(band.commits[0].subject, "feat(composer): status band")
    assert.match(band.blob, /^[0-9a-f]{40}$/)
    assert.match(report.gaps[0].draft.source, /record\(/)
    assert.equal(report.summary.commits, 4)
    assert.equal(report.summary.foreignCommits, 4)
    assert.equal(report.baseSha, base)
  } finally { await cleanup() }
})

test("our own author's new surface is a warn, not red", async () => {
  const { repo, base, cleanup } = await fixture()
  try {
    await repo.commit({ "components/agent-next/ours-widget.tsx": "export function OursWidget() { return <b data-testid=\"ours-widget\" /> }\n" }, US, "feat: widget")
    const report = await runCoverageGap({ root: repo.dir, config: { coverageGap: CONFIG }, base })
    assert.deepEqual(report.gaps.map((g) => `${g.severity} ${g.path}`), ["warn components/agent-next/ours-widget.tsx"])
    assert.equal(gateOutcome(report, "foreign").blocked, false, "foreign-only gating ignores warn gaps")
    assert.equal(gateOutcome(report, "all").blocked, true)
  } finally { await cleanup() }
})

test("FALSIFIABLE PAIR: the same teammate batch, once an acceptance script names the new testid and route, loses exactly those gaps", async () => {
  const { repo, base, cleanup } = await fixture()
  try {
    await colleagueBatch(repo)
    await repo.commit({ "scripts/acceptance/accept.mjs": "record('old', async () => { await page.click('[data-testid=\"old-thing-1\"]') })\nrecord('band', async () => { await page.locator('[data-testid=\"status-band\"]').waitFor() })\n" }, US, "test: band")
    const report = await runCoverageGap({ root: repo.dir, config: { coverageGap: CONFIG }, base })
    assert.deepEqual(report.gaps.map((g) => g.path), ["app/api/undo/route.ts"])
    await repo.commit({ "scripts/acceptance/undo.mjs": "await fetch(`${base}/api/undo`, { method: 'POST' })\n" }, US, "test: undo")
    const after = await runCoverageGap({ root: repo.dir, config: { coverageGap: CONFIG }, base })
    assert.deepEqual(after.gaps, [])
    assert.equal(gateOutcome(after, "all").blocked, false)
  } finally { await cleanup() }
})

test("--authors-not style: naming our author as the pattern reports only the foreign gaps", async () => {
  const { repo, base, cleanup } = await fixture()
  try {
    await colleagueBatch(repo)
    await repo.commit({ "components/agent-next/ours-widget.tsx": "export function OursWidget() {}\n" }, US, "feat: widget")
    const all = await runCoverageGap({ root: repo.dir, config: { coverageGap: { ...CONFIG, ownAuthors: [] } }, base })
    assert.equal(all.gaps.length, 3, "no ownAuthors configured: nobody is ours, everything is red")
    assert.ok(all.gaps.every((g) => g.severity === "red"))
    const foreign = await runCoverageGap({ root: repo.dir, config: { coverageGap: CONFIG }, base, authorsNot: ["AI Agent System"] })
    assert.deepEqual(foreign.gaps.map((g) => g.path).sort(), ["app/api/undo/route.ts", "components/agent-next/status-band.tsx"])
  } finally { await cleanup() }
})

test("ack: valid while the list is identical, stale when a gap appears or a gapped file changes", async () => {
  const { repo, dir, base, cleanup } = await fixture()
  try {
    await colleagueBatch(repo)
    const ackFile = join(dir, ".vibeubi", "coverage-ack.json")
    const config = { coverageGap: { ...CONFIG, ackFile } }
    const first = await runCoverageGap({ root: dir, config, base })
    assert.equal(first.ack.status, "none")
    assert.equal(gateOutcome(first, "all").blocked, true)
    await writeAck(ackFile, first, { by: "roy", note: "reviewed by hand" })
    assert.equal((await readAcks(ackFile)).length, 1)

    const second = await runCoverageGap({ root: dir, config, base })
    assert.equal(second.ack.status, "valid")
    assert.equal(second.ack.ack.by, "roy")
    assert.equal(gateOutcome(second, "all").blocked, false)

    await repo.commit({ "components/agent-next/another.tsx": "export function Another() {}\n" }, THEM, "feat: another")
    const third = await runCoverageGap({ root: dir, config, base })
    assert.equal(third.ack.status, "stale")
    assert.deepEqual(third.ack.added, ["new-surface:components/agent-next/another.tsx"])
    assert.equal(gateOutcome(third, "all").blocked, true)

    await writeAck(ackFile, third, { by: "roy", note: "again" })
    await repo.commit({ "components/agent-next/another.tsx": "export function Another() { return null }\n" }, THEM, "fix: another")
    const fourth = await runCoverageGap({ root: dir, config, base })
    assert.equal(fourth.ack.status, "stale")
    assert.deepEqual(fourth.ack.changed, ["new-surface:components/agent-next/another.tsx"])
  } finally { await cleanup() }
})

test("claims may be a (async) function, and delivery.features are claims too", async () => {
  const { repo, base, cleanup } = await fixture()
  try {
    await repo.commit({ "components/agent-next/status-band.tsx": "export function StatusBand() {}\n", "lib/extra/x.ts": "export const x = 1\n" }, THEM, "feat: two files")
    const config = {
      coverageGap: { ...CONFIG, claims: async () => [{ id: "late", covers: ["components/**"] }] },
      delivery: { features: [{ id: "extra", covers: ["lib/extra/**"] }] },
    }
    const report = await runCoverageGap({ root: repo.dir, config, base })
    assert.deepEqual(report.gaps.map((g) => `${g.kind} ${g.path}`), ["new-surface components/agent-next/status-band.tsx"], "lib/extra is claimed by the delivery feature; the component only by a wide glob")
    assert.equal(report.gaps[0].claimedBy[0].id, "late")
  } finally { await cleanup() }
})

test("a bad ref is a usage error, not a pass", async () => {
  const { dir, cleanup } = await fixture()
  try {
    await assert.rejects(runCoverageGap({ root: dir, config: { coverageGap: CONFIG }, base: "no-such-ref" }), (e) => e.code === "COVERAGE_GAP_USAGE")
  } finally { await cleanup() }
})

test("markdown report names the gaps, who wrote them, and carries the draft", async () => {
  const { repo, base, cleanup } = await fixture()
  try {
    await colleagueBatch(repo)
    const md = renderMarkdown(await runCoverageGap({ root: repo.dir, config: { coverageGap: CONFIG }, base }))
    assert.match(md, /# Coverage gap/)
    assert.match(md, /components\/agent-next\/status-band\.tsx/)
    assert.match(md, /Ubuntu/)
    assert.match(md, /```js[\s\S]*record\(/)
    assert.doesNotMatch(md, /docs\/readme\.md/)
  } finally { await cleanup() }
})

/* ── the CLI ─────────────────────────────────────────────────────────── */

const cli = (dir, args) => spawnSync(process.execPath, [BIN, "coverage-gap", "--root", dir, ...args], { encoding: "utf8" })

async function withConfig(dir, extra = "") {
  await writeFile(join(dir, "vibeubi.config.mjs"), `export default { name: "t", coverageGap: ${JSON.stringify(CONFIG)}${extra} }\n`)
}

test("CLI exit codes: 0 report-only, 1 with --fail-on-uncovered, 0 once acked by a human, 1 again when stale, 2 for a bad ref", async () => {
  const { repo, dir, base, cleanup } = await fixture()
  try {
    await colleagueBatch(repo)
    await withConfig(dir)
    assert.equal(cli(dir, ["--base", base]).status, 0, "report only")
    const gated = cli(dir, ["--base", base, "--fail-on-uncovered"])
    assert.equal(gated.status, 1)
    assert.match(gated.stdout, /status-band/)

    assert.equal(cli(dir, ["--base", base, "--ack"]).status, 2, "--ack needs --by")
    const acked = cli(dir, ["--base", base, "--ack", "--by", "roy", "--note", "checked"])
    assert.equal(acked.status, 0, acked.stderr)
    assert.ok(existsSync(join(dir, ".vibeubi", "coverage-ack.json")))
    const after = cli(dir, ["--base", base, "--fail-on-uncovered", "--format", "json"])
    assert.equal(after.status, 0, after.stdout)
    assert.equal(JSON.parse(after.stdout).ack.status, "valid")

    await repo.commit({ "components/agent-next/more.tsx": "export function More() {}\n" }, THEM, "feat: more")
    const stale = cli(dir, ["--base", base, "--fail-on-uncovered"])
    assert.equal(stale.status, 1)
    assert.match(stale.stdout, /ack is stale|stale/i)

    assert.equal(cli(dir, ["--base", "nope", "--fail-on-uncovered"]).status, 2)
    assert.equal(cli(dir, []).status, 2, "no base and no defaultBase: say so")
  } finally { await cleanup() }
})

test("CLI: --format json is machine-readable, --authors-not narrows, --drafts-dir writes one file per gap", async () => {
  const { repo, dir, base, cleanup } = await fixture()
  try {
    await colleagueBatch(repo)
    await repo.commit({ "components/agent-next/ours-widget.tsx": "export function OursWidget() {}\n" }, US, "feat: widget")
    await withConfig(dir)
    const drafts = join(dir, "out", "drafts")
    const r = cli(dir, ["--base", base, "--format", "json", "--authors-not", "AI Agent System", "--drafts-dir", drafts])
    assert.equal(r.status, 0, r.stderr)
    const report = JSON.parse(r.stdout)
    assert.equal(report.kind, "coverage-gap")
    assert.deepEqual(report.gaps.map((g) => g.path).sort(), ["app/api/undo/route.ts", "components/agent-next/status-band.tsx"])
    const files = (await readdir(drafts)).sort()
    assert.equal(files.length, 2)
    assert.match(await readFile(join(drafts, files.find((f) => f.startsWith("status-band"))), "utf8"), /status-band/)
    assert.equal(cli(dir, ["--base", base, "--authors-not", "AI Agent System", "--fail-on-uncovered", "foreign"]).status, 1)
  } finally { await cleanup() }
})

test("CLI: a project template is used for drafts, and a typo in it is a loud failure, not a silent skeleton", async () => {
  const { repo, dir, base, cleanup } = await fixture()
  try {
    await colleagueBatch(repo)
    await writeFile(join(dir, "tmpl.txt"), "// MINE {{id}} {{file}}\n")
    await writeFile(join(dir, "vibeubi.config.mjs"), `export default { name: "t", coverageGap: ${JSON.stringify({ ...CONFIG, templateFiles: { default: "tmpl.txt" } })} }\n`)
    const ok = cli(dir, ["--base", base, "--format", "json"])
    assert.match(JSON.parse(ok.stdout).gaps[0].draft.source, /^\/\/ MINE /)
    await writeFile(join(dir, "tmpl.txt"), "{{typo}}\n")
    const bad = cli(dir, ["--base", base])
    assert.notEqual(bad.status, 0)
    assert.match(bad.stderr + bad.stdout, /unknown placeholder/)
  } finally { await cleanup() }
})
