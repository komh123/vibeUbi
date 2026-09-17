/**
 * collect.mjs — all the I/O the rules refuse to do.
 *
 * The lexer here is not a nicety. `textRuleFitness` in the kernel refuses to
 * let a rule below 90% precision gate anything, and a regex with no idea what
 * a comment is will not clear that bar: measured elsewhere, a hand-written
 * scan produced 137 false positives out of 177. So every line is labelled
 * `code` / `comment` / `string` before a rule ever sees it.
 */
import { readdir, readFile, stat } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join, relative, extname } from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
const run = promisify(execFile)

/**
 * Directories a rule must never see.
 *
 * `dist-new` / `dist-prev` / `dist-snapshot` are here because of a live miss:
 * `dist` was skipped but the scratch copies this pipeline creates were not, so
 * a scan started reporting `innerHTML` inside a minified React vendor bundle.
 * Generated output is `generated` in `sourceScanHit`'s terms — a false
 * positive by definition, and nobody can act on a finding at column 30 of a
 * bundle they did not write.
 */
const SKIP = new Set([
  "node_modules", ".git", "coverage", ".cache", "__snapshots__", "screenshots-rwd",
  "dist", "dist-new", "dist-prev", "dist-snapshot", "build",
  ".next", ".next-new", ".next-prev", ".vibeubi", ".vibeship",
])

/**
 * Files whose entire content is deliberate examples.
 *
 * `canary.mjs` holds one sample per rule, each built to MATCH that rule — so a
 * scanner run over this repository flags its own bait and reports a fake key
 * and an unsanitised sink as real findings. That is the scanner working
 * correctly on a file whose purpose is to be caught, which is the same
 * situation as a planted fixture in a test, and `s2Sinks` already skips those
 * for the same reason.
 *
 * Named as a path rather than a pattern so it cannot quietly grow: an
 * exemption that matches "anything with canary in the name" is the wide kind
 * that turns off real checks sharing the surface.
 */
const DELIBERATE_EXAMPLES = new Set(["packages/security/src/canary.mjs"])

/** A line this long is minified: not something a person wrote or can fix. */
const MINIFIED_LINE = 500
const CODE_EXT = new Set([".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx"])

export async function walk(root, { maxBytes = 400_000 } = {}) {
  const out = []
  const go = async (dir) => {
    let entries = []
    try { entries = await readdir(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (SKIP.has(e.name)) continue
      const full = join(dir, e.name)
      if (e.isDirectory()) { await go(full); continue }
      try {
        const s = await stat(full)
        if (s.size > maxBytes) continue
        out.push({ path: relative(root, full), abs: full, size: s.size })
      } catch { /* unreadable: not a finding, just absent */ }
    }
  }
  await go(root)
  return out
}

/**
 * Label each line `code`, `comment` or `string`.
 *
 * Deliberately a small state machine, not a parser: it tracks `//`, block
 * comments and template literals, which is what the false positives actually
 * came from. It is allowed to be imprecise INSIDE a line — what it must never
 * do is call a comment `code`.
 */
export function lex(text) {
  const lines = String(text).split("\n")
  const out = []
  let inBlock = false, inTemplate = false
  lines.forEach((raw, i) => {
    const t = raw.trim()
    let region = "code"
    if (inBlock) {
      region = "comment"
      if (t.includes("*/")) inBlock = false
    } else if (t.startsWith("//") || t.startsWith("*")) {
      region = "comment"
    } else if (t.startsWith("/*")) {
      region = "comment"
      if (!t.includes("*/")) inBlock = true
    } else if (inTemplate) {
      region = "string"
      if ((raw.match(/`/g) || []).length % 2 === 1) inTemplate = false
    } else if ((raw.match(/`/g) || []).length % 2 === 1) {
      inTemplate = true
    }
    out.push({ n: i + 1, text: raw, region })
  })
  return out
}

/** Code files, lexed. */
export async function codeFiles(root, files) {
  const out = []
  for (const file of files) {
    if (DELIBERATE_EXAMPLES.has(file.path)) continue
    if (!CODE_EXT.has(extname(file.path))) continue
    try {
      const text = await readFile(file.abs, "utf8")
      // Minified or bundled: generated, so any match is a false positive.
      if (text.split("\n").some((l) => l.length > MINIFIED_LINE)) continue
      out.push({ path: file.path, text, lines: lex(text) })
    } catch { /* skip */ }
  }
  return out
}

/** Files that could hold a credential — code, config, env, yaml, json. */
export async function scannableFiles(root, files) {
  const ok = /\.(js|mjs|cjs|ts|tsx|jsx|json|ya?ml|env|sh|conf|toml|ini|md)$|(^|\/)\.env/
  const out = []
  for (const file of files) {
    if (!ok.test(file.path)) continue
    if (DELIBERATE_EXAMPLES.has(file.path)) continue
    try { out.push({ path: file.path, text: await readFile(file.abs, "utf8") }) } catch { /* skip */ }
  }
  return out
}

/**
 * Credentials in git history.
 *
 * A key deleted in the next commit is still a key: anyone who can clone reads
 * it. Bounded by `--max-count` because this is the one collector that can run
 * for minutes on a large repo, and a scan people cancel is a scan that never
 * runs.
 */
export async function gitHistory(root, { maxCommits = 400 } = {}) {
  if (!existsSync(join(root, ".git"))) return []
  try {
    const { stdout } = await run("git", ["-C", root, "log", "-p", "--no-color", `--max-count=${maxCommits}`, "--", "."],
      { maxBuffer: 120 * 1024 * 1024 })
    const out = []
    let commit = "", path = ""
    for (const line of stdout.split("\n")) {
      if (line.startsWith("commit ")) { commit = line.slice(7, 15); continue }
      if (line.startsWith("+++ b/")) { path = line.slice(6); continue }
      if (line.startsWith("+") && !line.startsWith("+++")) {
        out.push({ commit, path, text: line.slice(1) })
      }
    }
    return out
  } catch { return [] }
}

export async function trackedEnvFiles(root) {
  try {
    const { stdout } = await run("git", ["-C", root, "ls-files"], { maxBuffer: 16 * 1024 * 1024 })
    return stdout.split("\n").filter((p) => /(^|\/)\.env($|\.)/.test(p))
  } catch { return [] }
}

export async function npmAudit(root) {
  try {
    const { stdout } = await run("npm", ["audit", "--json", "--audit-level=low"],
      { cwd: root, maxBuffer: 64 * 1024 * 1024 })
    return parseAudit(stdout)
    /**
     * Output present and nothing extracted is a PARSER failure, not an empty
     * machine — and the two are indistinguishable downstream, because both
     * produce an empty list. This is the check that would have caught the
     * column bug above on the day it was written.
     */
    if (rows.length > 0 && out.length === 0) {
      live = false
      why = `\`ss -ltnp\` returned ${rows.length} row(s) and none could be parsed — the parser is broken, not the machine empty`
    }
  } catch (err) {
    // npm audit exits non-zero when it finds things; the JSON is still on stdout.
    if (err.stdout) { try { return parseAudit(err.stdout) } catch { /* fall through */ } }
    return { available: false, advisories: [], why: "npm audit could not run here" }
  }
}

function parseAudit(stdout) {
  const j = JSON.parse(stdout)
  const vulns = j.vulnerabilities ?? {}
  const advisories = []
  for (const [name, v] of Object.entries(vulns)) {
    const via = (v.via ?? []).find((x) => typeof x === "object")
    advisories.push({
      name, severity: v.severity, range: v.range,
      title: via?.title, cve: via?.url?.match(/GHSA-[\w-]+/)?.[0],
      fixAvailable: Boolean(v.fixAvailable),
    })
  }
  return { available: true, advisories }
}

/**
 * Every listener on this machine, plus what the manifests say should exist.
 * The union is the point: a port in a manifest that is not listening and a
 * port listening that is in no manifest are both worth knowing.
 */
/**
 * Every listener on this machine, plus what the manifests say should exist.
 *
 * `live` says whether this machine could be OBSERVED at all, and it has to be
 * reported because without it the two sources collapse. `ss` sees what is
 * ACTUALLY listening; the manifests see what was DECLARED to listen. If `ss`
 * cannot run you are left with only declared ports — so `S4.exposure.orphan`,
 * whose entire job is to find a listener nobody declared, becomes structurally
 * unable to fire. It reports zero, which reads exactly like a machine with
 * nothing undeclared on it.
 *
 * The canary does not catch this: it proves the RULE still fires, not that the
 * collector found anything for it to fire on. A peer hit the same shape from
 * the other side — copying a weaker validation onto a wider source — and the
 * lesson is the same either way: a guard that cannot see its wider input is
 * not a guard, and it looks like a pass.
 */
export async function listeners(root) {
  const out = []
  let live = false
  let why
  try {
    const { stdout } = await run("ss", ["-ltnp"], { maxBuffer: 8 * 1024 * 1024 })
    live = true
    /**
     * `ss -ltnp` columns:  State  Recv-Q  Send-Q  Local:Port  Peer:Port  Process
     *
     * The first version skipped FOUR fields and captured the fifth — which is
     * the PEER address, `0.0.0.0:*`, where `(\d+)` can never match a `*`. So it
     * matched nothing, on every machine, forever. Measured here: 49 real
     * listeners, 0 parsed, and `S4.exposure.orphan` — the rule whose entire job
     * is to find a listener nobody declared — had never once fired on real data.
     *
     * Three is the right number of fields to skip.
     */
    const rows = stdout.split("\n").slice(1).filter((l) => l.trim())
    for (const line of rows) {
      const m = /^\S+\s+\S+\s+\S+\s+(\S+):(\d+)\s/.exec(line)
      if (!m) continue
      const proc = /users:\(\("([^"]+)"/.exec(line)?.[1]
      out.push({ service: proc ?? "unknown", bind: m[1].replace(/^\[|\]$/g, ""), port: Number(m[2]), process: proc, source: "ss" })
    }
    /**
     * Output present and nothing extracted is a PARSER failure, not an empty
     * machine — and downstream the two are indistinguishable, because both
     * produce an empty list. This is the check that would have caught the
     * column bug above on the day it was written, instead of never.
     */
    if (rows.length > 0 && out.length === 0) {
      live = false
      why = `\`ss -ltnp\` returned ${rows.length} row(s) and none could be parsed — the parser is broken, not the machine empty`
    }
  } catch (err) {
    // The manifests still contribute, but they can only ever confirm what was
    // already declared, so the orphan rule cannot fire. Say so.
    why = `\`ss -ltnp\` could not run here (${err.code ?? err.message}), so nothing was observed actually listening — only what the manifests declare`
  }

  for (const rel of ["docker-compose.yml", "docker-compose.yaml", "compose.yml"]) {
    const p = join(root, rel)
    if (!existsSync(p)) continue
    const text = await readFile(p, "utf8")
    for (const m of text.matchAll(/^\s*-\s*["']?(?:(\d+\.\d+\.\d+\.\d+):)?(\d+):(\d+)/gm)) {
      out.push({ service: rel, bind: m[1] ?? "0.0.0.0", port: Number(m[2]), source: "compose" })
    }
  }

  const k8s = join(root, "k8s")
  if (existsSync(k8s)) {
    for (const file of await walk(k8s)) {
      if (!/\.ya?ml$/.test(file.path)) continue
      const text = await readFile(file.abs, "utf8")
      if (!/kind:\s*Service/.test(text)) continue
      const type = /type:\s*(\w+)/.exec(text)?.[1] ?? "ClusterIP"
      const name = /name:\s*(\S+)/.exec(text)?.[1] ?? file.path
      for (const m of text.matchAll(/(?:nodePort|port):\s*(\d+)/g)) {
        out.push({
          service: `k8s/${name}`, port: Number(m[1]),
          bind: type === "ClusterIP" ? "cluster" : "0.0.0.0",
          source: `k8s ${type}`,
        })
      }
    }
  }
  const seen = new Set()
  const deduped = out.filter((l) => { const k = `${l.service}:${l.port}:${l.bind}`; return !seen.has(k) && seen.add(k) })
  return { listeners: deduped, live, why }
}

export async function dockerAndCompose(root, files) {
  const dockerfiles = [], compose = []
  const hasIgnore = existsSync(join(root, ".dockerignore"))
  for (const file of files) {
    const base = file.path.split("/").pop()
    if (/^Dockerfile/.test(base)) dockerfiles.push({ path: file.path, text: await readFile(file.abs, "utf8"), hasDockerignore: hasIgnore })
    if (/^docker-compose.*\.ya?ml$|^compose\.ya?ml$/.test(base)) compose.push({ path: file.path, text: await readFile(file.abs, "utf8") })
  }
  return { dockerfiles, compose }
}
