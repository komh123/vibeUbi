/**
 * coverage-gap (git half) — read the commits since a base and say what they added that nothing exercises.
 *
 * The decisions live in `kernel/src/coverage-gap.mjs` (pure). This file only reads git, reads the evidence files,
 * loads templates, keeps the ack file, and prints. It reads the COMMITTED range `base head`; the working tree is
 * never part of the answer, and `head` may be a remote ref.
 */
import { execFile, spawn } from "node:child_process"
import { readFile, writeFile, mkdir } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { promisify } from "node:util"
import { compileGlobs, authorIsOwn, computeGaps, ackVerdict, makeAck, draftFor } from "../../kernel/src/index.mjs"

const run = promisify(execFile)
const MAX = 512 << 20

export const DEFAULT_ACK_FILE = ".vibeubi/coverage-ack.json"
/** Evidence defaults to end-to-end/spec scripts. A project should name the scripts that actually drive its product. */
export const DEFAULT_EVIDENCE = Object.freeze(["e2e/**", "**/e2e/**", "**/*.e2e.*", "**/*.spec.*"])

export class CoverageGapUsageError extends Error {
  constructor(message) { super(message); this.code = "COVERAGE_GAP_USAGE" }
}

const git = async (root, args, options = {}) =>
  (await run("git", ["-C", root, "-c", "core.quotepath=off", ...args], { encoding: "utf8", maxBuffer: MAX, ...options })).stdout

async function resolveCommit(root, ref, what) {
  try { return (await git(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])).trim() } catch {
    throw new CoverageGapUsageError(`${what} "${ref}" is not a commit in ${root}`)
  }
}

/* ─────────────────────────────── commits ─────────────────────────────── */

/**
 * Every commit in `base..head`, newest first, with author, whether it is ours, and the files it changed.
 * Merges are listed (`isMerge`) and own no files: the commits they brought in are in the range too, which is
 * how "merge expansion" works without special cases.
 *
 * @returns {Promise<{sha:string, parents:string[], isMerge:boolean, author:{name:string,email:string}, own:boolean, subject:string, files:{status:string,path:string,oldPath?:string}[]}[]>}
 */
export async function commitsSince(base, head, { root = process.cwd(), ownAuthors = [] } = {}) {
  const out = await git(root, ["log", "--name-status", "-M", "--format=%x01%H%x1f%P%x1f%an%x1f%ae%x1f%s", `${base}..${head}`])
  const commits = []
  for (const chunk of out.split("\x01").slice(1)) {
    const [header, ...rest] = chunk.split("\n")
    const [sha, parents, name, email, subject] = header.split("\x1f")
    const files = []
    for (const line of rest) {
      if (!line.trim()) continue
      const [status, a, b] = line.split("\t")
      files.push(/^[RC]/.test(status) ? { status: status[0], oldPath: a, path: b } : { status: status[0], path: a })
    }
    const author = { name, email }
    const parentList = parents ? parents.split(" ") : []
    commits.push({ sha, parents: parentList, isMerge: parentList.length > 1, author, own: authorIsOwn(author, ownAuthors), subject, files })
  }
  return commits
}

/* ─────────────────────────────── the range ─────────────────────────────── */

function parseNameStatus(out) {
  const parts = out.split("\0")
  const files = []
  for (let i = 0; i < parts.length;) {
    const status = parts[i]
    if (!status) { i++; continue }
    if (/^[RC]/.test(status)) { files.push({ status: status[0], oldPath: parts[i + 1], path: parts[i + 2] }); i += 3 } else { files.push({ status: status[0], path: parts[i + 1] }); i += 2 }
  }
  return files
}

/** The `+` lines of every file in a zero-context unified diff, keyed by the new path. */
export function addedTextByFile(diff) {
  const added = new Map()
  let current = null
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) current = null
    else if (line.startsWith("+++ ")) { const p = line.slice(4); current = p === "/dev/null" ? null : p.replace(/\t.*$/, "").replace(/^b\//, ""); if (current) added.set(current, []) }
    else if (current && line.startsWith("+")) added.get(current).push(line.slice(1))
  }
  return new Map([...added].map(([k, v]) => [k, v.join("\n")]))
}

async function readRange(root, baseSha, headSha) {
  const files = parseNameStatus(await git(root, ["diff", "-M", "--name-status", "-z", baseSha, headSha]))
  const added = addedTextByFile(await git(root, ["diff", "-M", "-U0", "--no-color", "--no-ext-diff", baseSha, headSha]))
  return files.map((f) => ({ ...f, addedText: added.get(f.path) ?? "" }))
}

/** Authors of the (non-merge) commits that touched each path, following renames inside the range. */
function authorsByFile(commits) {
  const direct = new Map(), alias = new Map(), byPath = new Map()
  for (const c of commits) {
    if (c.isMerge) continue
    for (const f of c.files) {
      if (!direct.has(f.path)) direct.set(f.path, [])
      direct.get(f.path).push(c)
      if (f.oldPath) alias.set(f.path, f.oldPath)
    }
  }
  const all = (path, seen = new Set()) => {
    if (seen.has(path)) return []
    seen.add(path)
    return [...(direct.get(path) ?? []), ...(alias.has(path) ? all(alias.get(path), seen) : [])]
  }
  for (const path of direct.keys()) byPath.set(path, all(path))
  return byPath
}

/* ─────────────────────────────── tree access ─────────────────────────────── */

/** Read blobs at a ref in one process: `git cat-file --batch`. Returns Map(path → {oid, text|null}). */
async function catBlobs(root, ref, paths, { text = true } = {}) {
  const result = new Map()
  if (!paths.length) return result
  const child = spawn("git", ["-C", root, "cat-file", text ? "--batch" : "--batch-check"], { stdio: ["pipe", "pipe", "pipe"] })
  const chunks = []
  child.stdout.on("data", (c) => chunks.push(c))
  const closed = new Promise((res, rej) => { child.on("close", res); child.on("error", rej) })
  child.stdin.end(paths.map((p) => `${ref}:${p}\n`).join(""))
  await closed
  const buf = Buffer.concat(chunks)
  let at = 0
  for (const path of paths) {
    const eol = buf.indexOf(10, at)
    if (eol < 0) break
    const header = buf.toString("utf8", at, eol)
    at = eol + 1
    const m = header.match(/^([0-9a-f]+) (\w+) (\d+)$/)
    if (!m) { result.set(path, { oid: null, text: null }); continue }
    const size = Number(m[3])
    if (text) { result.set(path, { oid: m[1], text: m[2] === "blob" ? buf.toString("utf8", at, at + size) : null }); at += size + 1 } else result.set(path, { oid: m[1], text: null })
  }
  return result
}

async function readTree(root, treeRef, headSha, evidenceTest) {
  if (treeRef === "worktree") {
    const tracked = (await git(root, ["ls-files", "-z"])).split("\0").filter(Boolean)
    const evidence = []
    for (const path of tracked.filter(evidenceTest)) { try { evidence.push({ path, text: await readFile(join(root, path), "utf8") }) } catch { /* deleted in the worktree */ } }
    return { tracked, evidence }
  }
  const sha = treeRef === "head" ? headSha : await resolveCommit(root, treeRef, "tree")
  const tracked = (await git(root, ["ls-tree", "-r", "--name-only", "-z", sha])).split("\0").filter(Boolean)
  const blobs = await catBlobs(root, sha, tracked.filter(evidenceTest))
  return { tracked, evidence: [...blobs].filter(([, b]) => b.text != null).map(([path, b]) => ({ path, text: b.text })) }
}

/* ─────────────────────────────── the report ─────────────────────────────── */

async function loadTemplates(root, cfg) {
  const out = { ...(cfg.templates ?? {}) }
  for (const [cls, rel] of Object.entries(cfg.templateFiles ?? {})) out[cls] = await readFile(resolve(root, rel), "utf8")
  return Object.keys(out).length ? out : undefined
}

/**
 * Claims from `coverageGap.claims` (a list, or a function returning one — sync or async, so a project can build it
 * from modules that would be circular at import time) plus the project's delivery features.
 */
export async function claimsOf(config, { root } = {}) {
  const cfg = config.coverageGap ?? {}
  const declared = typeof cfg.claims === "function" ? await cfg.claims({ root }) : (cfg.claims ?? [])
  const features = cfg.useDeliveryFeatures === false ? [] : (config.delivery?.features ?? [])
  return [...declared, ...features.map((f) => ({ id: f.id, covers: f.covers }))]
}

/**
 * @param {object} o
 * @param {string} o.root
 * @param {{ coverageGap?: object, delivery?: object }} o.config  the project's vibeubi config
 * @param {string} o.base
 * @param {string} [o.head]
 * @param {readonly (string|RegExp)[]} [o.authorsNot]  overrides `ownAuthors` AND reports only the foreign gaps
 * @param {string} [o.tree] where claims' breadth and evidence are read: a ref, "head" (default) or "worktree"
 */
export async function runCoverageGap({ root, config, base, head = "HEAD", authorsNot, tree, ackFile }) {
  const cfg = config.coverageGap ?? {}
  if (!base) throw new CoverageGapUsageError("coverage-gap needs --base <ref> (the commit that is live), or coverageGap.defaultBase in the config")
  const baseSha = await resolveCommit(root, base, "base")
  const headSha = await resolveCommit(root, head, "head")
  const ownAuthors = authorsNot?.length ? authorsNot : (cfg.ownAuthors ?? [])

  const commits = await commitsSince(baseSha, headSha, { root, ownAuthors })
  const changed = await readRange(root, baseSha, headSha)
  const touching = authorsByFile(commits)
  const authorsMap = Object.fromEntries([...touching].map(([p, cs]) => [p, cs.map((c) => c.author)]))

  const evidenceTest = compileGlobs(cfg.evidence ?? DEFAULT_EVIDENCE)
  const { tracked, evidence } = await readTree(root, tree ?? cfg.tree ?? "head", headSha, evidenceTest)

  const computed = computeGaps({
    files: changed, authorsByFile: authorsMap, claims: await claimsOf(config, { root }), ignored: cfg.ignored ?? [], tracked, evidence,
    ownAuthors, classifier: cfg.classifier ?? {}, exemptClasses: cfg.exemptClasses, broadThreshold: cfg.broadThreshold,
  })
  let gaps = authorsNot?.length ? computed.gaps.filter((g) => g.foreign) : computed.gaps

  const blobs = await catBlobs(root, headSha, gaps.map((g) => g.path), { text: false })
  const templates = await loadTemplates(root, cfg)
  gaps = gaps.map((g) => {
    const cs = (touching.get(g.path) ?? []).map((c) => ({ sha: c.sha, author: c.author.name, subject: c.subject }))
    const withBits = { ...g, blob: blobs.get(g.path)?.oid ?? "", commits: cs }
    return { ...withBits, draft: draftFor(withBits, templates) }
  })

  const acks = await readAcks(resolve(root, ackFile ?? cfg.ackFile ?? DEFAULT_ACK_FILE))
  const nonMerge = commits.filter((c) => !c.isMerge)
  return {
    kind: "coverage-gap", base, head, baseSha, headSha, tree: tree ?? cfg.tree ?? "head",
    summary: {
      commits: commits.length, merges: commits.length - nonMerge.length, foreignCommits: nonMerge.filter((c) => !c.own).length,
      ...computed.stats, gaps: gaps.length, red: gaps.filter((g) => g.severity === "red").length, warn: gaps.filter((g) => g.severity === "warn").length,
    },
    commits: commits.map(({ sha, author, own, isMerge, subject }) => ({ sha, author: `${author.name} <${author.email}>`, own, isMerge, subject })),
    gaps, ack: ackVerdict({ acks, gaps }),
  }
}

/* ─────────────────────────────── ack file ─────────────────────────────── */

export async function readAcks(file) {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"))
    return Array.isArray(parsed?.acks) ? parsed.acks : []
  } catch (error) {
    if (error?.code === "ENOENT") return []
    throw new CoverageGapUsageError(`cannot read the ack file ${file}: ${error.message}`)
  }
}

/** Append an acknowledgement of the report's current gap list. Only a person should call this. */
export async function writeAck(file, report, { by, note = "", at = new Date().toISOString() }) {
  if (!by) throw new CoverageGapUsageError("an acknowledgement needs --by <who>")
  const acks = await readAcks(file)
  acks.push(makeAck({ gaps: report.gaps, by, note, at, base: report.baseSha, head: report.headSha }))
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify({ version: 1, acks }, null, 2) + "\n")
  return acks.at(-1)
}

/* ─────────────────────────────── outcome + output ─────────────────────────────── */

/**
 * Does this report stop a merge/release? `failOn`: false (never) | "all" | "foreign" (red gaps only).
 * A valid ack lifts the block; a missing or stale one does not.
 */
export function gateOutcome(report, failOn) {
  const scope = !failOn ? [] : failOn === "foreign" ? report.gaps.filter((g) => g.severity === "red") : report.gaps
  if (scope.length === 0) return { blocked: false, scope, reason: failOn ? "nothing in scope" : "report only" }
  if (report.ack.status === "valid") return { blocked: false, scope, reason: `acknowledged by ${report.ack.ack.by} at ${report.ack.ack.at}` }
  const stale = report.ack.status === "stale"
    ? ` An earlier acknowledgement by ${report.ack.ack.by} is stale: ${report.ack.added.length} gap(s) added, ${report.ack.removed.length} gone, ${report.ack.changed.length} file(s) changed since.`
    : ""
  return { blocked: true, scope, reason: `${scope.length} gap(s) nobody has acknowledged.${stale}` }
}

export function renderMarkdown(report) {
  const s = report.summary
  const lines = [
    `# Coverage gap ${report.baseSha.slice(0, 9)}..${report.headSha.slice(0, 9)}`, "",
    `${s.commits} commit(s) (${s.foreignCommits} not ours, ${s.merges} merge(s)); ${s.files} changed file(s), ${s.exempt} exempt (docs/tests/config/ignored), ${s.covered} covered.`,
    `**${s.gaps} gap(s): ${s.red} red (not our author), ${s.warn} warn (ours).**`,
    report.ack.status === "valid" ? `Acknowledged by ${report.ack.ack.by} at ${report.ack.ack.at}${report.ack.ack.note ? `: ${report.ack.ack.note}` : ""}.`
      : report.ack.status === "stale" ? `An earlier acknowledgement by ${report.ack.ack.by} is **stale** (added ${report.ack.added.length}, removed ${report.ack.removed.length}, changed ${report.ack.changed.length}).` : "",
    "",
  ]
  for (const g of report.gaps) {
    const who = g.authors.map((a) => `${a.name}${a.own ? " (ours)" : ""}`).join(", ") || "unknown"
    lines.push(`## ${g.severity === "red" ? "RED" : "warn"} ${g.kind}: \`${g.path}\``, "",
      `- class ${g.class}, ${g.status === "A" ? "new file" : "changed"}${g.route ? `, route \`${g.route}\`` : ""}; by ${who}`,
      `- claimed by: ${g.claimedBy.map((c) => `\`${c.glob}\` (${c.breadth} files; ${c.ids.length} claim(s), e.g. ${c.ids.slice(0, 2).join(", ")})`).join(", ") || "nothing"}`,
      ...(g.tokens.length ? [`- looked for in evidence, found none: ${g.tokens.map((t) => `\`${t}\``).join(", ")}`] : []),
      ...g.commits.map((c) => `- ${c.sha.slice(0, 7)} ${c.author}: ${c.subject}`), "",
      "```js", g.draft.source.trimEnd(), "```", "")
  }
  return lines.filter((l, i, all) => !(l === "" && all[i - 1] === "")).join("\n")
}

export async function writeDrafts(dir, report) {
  await mkdir(dir, { recursive: true })
  const written = []
  for (const g of report.gaps) {
    const file = join(dir, g.draft.fileName)
    await writeFile(file, g.draft.source)
    written.push(file)
  }
  return written
}
