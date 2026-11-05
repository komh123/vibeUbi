/**
 * coverage-gap.mjs — which of the things a set of commits added is exercised by NOTHING?
 *
 * The question the file-level claims cannot answer. A teammate who does not use
 * vibeubi merges a screen; every file of it is "claimed" by `components/**`, so
 * the gate has no orphan to report and stays green. A wide glob proves somebody
 * owns the directory. It does not prove anything drives the new thing.
 *
 * So this separates two facts that `checklist().uncovered` conflates:
 *
 *   unclaimed    no claim glob matches the file at all.
 *   new-surface  the file is NEW (or its added lines introduce a new data-testid,
 *                exported component or HTTP handler) in class route/page/component/
 *                api, and neither (a) a SPECIFIC claim (one that matches few files)
 *                nor (b) some evidence text that mentions the new thing exercises it.
 *
 * Everything here is pure: file lists, diffs' added text and evidence texts go
 * in; gaps come out. Reading git is the ship package's job.
 */
import { createHash } from "node:crypto"
import { compileGlobs } from "./inputs.mjs"

/* ─────────────────────────────── classifier ─────────────────────────────── */

const EXT_CODE = ["ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts"]
const expand = (pattern) => {
  const m = pattern.match(/\{([^{}]+)\}/)
  return m ? m[1].split(",").flatMap((alt) => expand(pattern.replace(m[0], alt))) : [pattern]
}
const braces = (...patterns) => patterns.flatMap(expand)

/** Ordered: the first rule whose glob matches wins. Project rules are tried before these. */
export const DEFAULT_CLASS_RULES = Object.freeze([
  { class: "test", match: braces("**/__tests__/**", "**/*.test.*", "**/*.spec.*", "**/test/**", "**/tests/**", "**/e2e/**") },
  { class: "docs", match: braces("docs/**", "**/*.md", "LICENSE*", "NOTICE*", "CHANGELOG*") },
  { class: "config", match: braces(
    "**/package.json", "**/package-lock.json", "**/*.lock", "**/pnpm-lock.yaml", "**/*.config.*", "**/tsconfig*.json",
    "**/Dockerfile*", "**/.dockerignore", "**/.env*", "**/.gitignore", ".github/**", "**/*.json", "**/*.yml", "**/*.yaml", "**/*.toml") },
  { class: "api", match: braces(`**/app/api/**/route.{${EXT_CODE.join(",")}}`, "**/pages/api/**", `**/routes/**/*.{${EXT_CODE.join(",")}}`) },
  { class: "route", match: braces(`**/app/**/route.{${EXT_CODE.join(",")}}`) },
  { class: "page", match: braces(
    "**/app/**/{page,layout,template,loading,error,not-found,global-error,default}.{tsx,ts,jsx,js,mdx}",
    "**/pages/**/*.{tsx,jsx,ts,js,vue,svelte}", "**/+page.svelte") },
  { class: "component", match: braces("**/*.{tsx,jsx,vue,svelte}") },
  { class: "lib", match: braces(`**/*.{${EXT_CODE.join(",")}}`) },
])

const compiledRules = new WeakMap()
const compile = (rules) => {
  let c = compiledRules.get(rules)
  if (!c) compiledRules.set(rules, (c = rules.map((r) => ({ class: r.class, test: compileGlobs(r.match) }))))
  return c
}

/**
 * @param {string} file repo-relative, forward slashes
 * @param {{ rules?: readonly {class:string, match:readonly string[]}[], replace?: boolean, classify?: (file:string, dflt:string)=>string|undefined }} [options]
 *   `rules` are tried first; `replace` drops the defaults; `classify` has the last word.
 */
export function classifyFile(file, { rules = [], replace = false, classify } = {}) {
  let dflt = "other"
  const tiers = replace ? [rules] : [rules, DEFAULT_CLASS_RULES]
  outer: for (const tier of tiers) {
    for (const r of compile(tier)) if (r.test(file)) { dflt = r.class; break outer }
  }
  const mine = classify?.(file, dflt)
  return typeof mine === "string" && mine ? mine : dflt
}

/* ─────────────────────────────── surfaces ─────────────────────────────── */

const HTTP = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"])
const uniq = (list) => [...new Set(list)].sort()
const hit = (re, text, pick) => { const out = []; for (const m of text.matchAll(re)) { const v = pick(m); if (v) out.push(v) } return out }

/** The route a file serves, from its path (Next.js app/ and pages/ routers). `null` when the file is not a route. */
export function routeOf(file) {
  const parts = file.split("/")
  const last = parts.at(-1) ?? ""
  const app = parts.indexOf("app")
  const pages = parts.indexOf("pages")
  let segments = null
  if (app >= 0 && /^(page|route|layout|template|loading|error|not-found|global-error|default)\.[a-z]+$/.test(last)) segments = parts.slice(app + 1, -1)
  else if (pages >= 0 && last !== "") segments = [...parts.slice(pages + 1, -1), last.replace(/\.[a-z]+$/, "")].filter((s) => s !== "index")
  if (!segments) return null
  const kept = segments.filter((s) => !/^\(.*\)$/.test(s) && !s.startsWith("@"))
  return "/" + kept.join("/")
}

/**
 * What a changed file exposes to a user or caller, read from text (the whole file when it is new, the added
 * lines when it is not). Only literal values: a template-built data-testid cannot be asked for by name.
 */
export function extractSurface(text, { class: cls = "other" } = {}) {
  const src = String(text ?? "")
  const testIds = hit(/data-test-?id\s*=\s*(?:"([^"{}$]+)"|'([^'{}$]+)'|\{\s*(?:"([^"$]+)"|'([^'$]+)'|`([^`$]+)`)\s*\})/g, src, (m) => m.slice(1).find(Boolean))
  const ariaLabels = hit(/aria-label\s*=\s*(?:"([^"{}]+)"|'([^'{}]+)')/g, src, (m) => m[1] ?? m[2])
  const apiCalls = hit(/["'`](\/api\/[A-Za-z0-9_\-./[\]]*[A-Za-z0-9_\]]?)/g, src, (m) => m[1].replace(/\/+$/, ""))
  const methods = [
    ...hit(/export\s+(?:async\s+)?function\s+([A-Z]+)\b/g, src, (m) => m[1]),
    ...hit(/export\s+const\s+([A-Z]+)\s*[=:]/g, src, (m) => m[1]),
  ].filter((n) => HTTP.has(n))
  const named = [
    ...hit(/export\s+(?:default\s+)?(?:async\s+)?(?:function|class)\s+([A-Z]\w*)/g, src, (m) => m[1]),
    ...hit(/export\s+const\s+([A-Z]\w*)\s*[=:]/g, src, (m) => m[1]),
  ].filter((n) => !HTTP.has(n))
  return {
    testIds: uniq(testIds), ariaLabels: uniq(ariaLabels), apiCalls: uniq(apiCalls),
    httpMethods: uniq(methods), exports: cls === "component" || cls === "page" ? uniq(named) : [],
  }
}

/* ───────────────────────────────── authors ───────────────────────────────── */

/**
 * Is this author one of ours? A string with no `*` must equal the name, the email or `Name <email>` (case-insensitive);
 * with `*` it is a glob over `Name <email>`; a RegExp is tested over `Name <email>`. No patterns: nobody is ours.
 */
export function authorIsOwn(author, patterns = []) {
  const name = String(author?.name ?? ""), email = String(author?.email ?? "")
  const full = `${name} <${email}>`.toLowerCase()
  return patterns.some((p) => {
    if (p instanceof RegExp) return p.test(`${name} <${email}>`)
    const q = String(p).toLowerCase()
    return q.includes("*") ? compileGlobs([q])(full) : q === name.toLowerCase() || q === email.toLowerCase() || q === full
  })
}

/* ───────────────────────────────── the gap ───────────────────────────────── */

export const DEFAULT_EXEMPT_CLASSES = Object.freeze(["docs", "test", "config"])
export const SURFACE_CLASSES = Object.freeze(["route", "page", "component", "api"])
export const DEFAULT_BROAD_THRESHOLD = 25

const kebab = (s) => s.replace(/([a-z0-9])([A-Z])/g, "$1-$2").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase()
const baseName = (file) => (file.split("/").at(-1) ?? "").replace(/\.[^.]+$/, "")
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** The route fragment an acceptance script would plausibly contain: static part, no leading `[locale]`, none past the first dynamic segment. */
function routeToken(route) {
  if (!route) return null
  const segs = route.split("/").filter(Boolean)
  while (segs.length && /^\[.*\]$/.test(segs[0])) segs.shift()
  const stat = []
  for (const s of segs) { if (/^\[.*\]$/.test(s)) break; stat.push(s) }
  const token = "/" + stat.join("/")
  return token.length >= 4 ? token : null
}

/** Words that, if some evidence file says them, mean somebody drives this surface. */
export function surfaceTokens({ path, class: cls, route, surface }) {
  const tokens = new Set()
  for (const id of surface.testIds) if (id.length >= 3) tokens.add(id)
  const rt = routeToken(route)
  if (rt) tokens.add(rt)
  for (const name of surface.exports) if (name.length >= 4) tokens.add(name)
  if (cls === "component") { const b = baseName(path); if (b.length >= 4) tokens.add(b) }
  return [...tokens].sort()
}

const mentionRegex = (token) =>
  new RegExp(`${token.startsWith("/") ? "" : "(?<![A-Za-z0-9_-])"}${escapeRe(token)}(?![A-Za-z0-9_-])`)

const normalizeClaims = (claims) => claims.flatMap((c) => {
  const id = typeof c === "string" ? c : String(c.id ?? c.name ?? "(claim)")
  const globs = typeof c === "string" ? [c] : [...(c.covers ?? []), ...(c.selfPaths ?? []), ...(c.globs ?? [])]
  return globs.map((glob) => ({ id, glob, test: compileGlobs([glob]) }))
})

/**
 * @param {object} o
 * @param {readonly {path:string, oldPath?:string, status:string, addedText?:string}[]} o.files the net change base..head
 * @param {Record<string, readonly {name:string,email:string}[]>} o.authorsByFile
 * @param {readonly (string | {id?:string, covers?:string[], selfPaths?:string[], globs?:string[]})[]} o.claims
 * @param {readonly string[]} [o.ignored]
 * @param {readonly string[]} [o.tracked] every tracked path (to measure how wide a claim is)
 * @param {readonly {path:string, text:string}[]} [o.evidence]
 * @param {readonly (string|RegExp)[]} [o.ownAuthors]
 */
export function computeGaps({
  files, authorsByFile = {}, claims = [], ignored = [], tracked = [], evidence = [], ownAuthors = [],
  classifier = {}, exemptClasses = DEFAULT_EXEMPT_CLASSES, surfaceClasses = SURFACE_CLASSES, broadThreshold = DEFAULT_BROAD_THRESHOLD,
}) {
  const claimGlobs = normalizeClaims(claims)
  const isIgnored = compileGlobs(ignored)
  const universe = [...new Set([...tracked, ...files.map((f) => f.path)])]
  const breadthCache = new Map()
  const breadth = (c) => {
    const key = c.glob
    if (!breadthCache.has(key)) breadthCache.set(key, universe.reduce((n, f) => n + (c.test(f) ? 1 : 0), 0))
    return breadthCache.get(key)
  }
  const mentionCache = new Map()
  const mentioned = (token) => {
    if (!mentionCache.has(token)) { const re = mentionRegex(token); mentionCache.set(token, evidence.some((e) => re.test(e.text))) }
    return mentionCache.get(token)
  }

  const stats = { files: 0, exempt: 0, covered: 0, exercisedByMention: 0, exercisedBySpecificClaim: 0, gaps: 0 }
  const gaps = []
  for (const f of files) {
    if (f.status === "D") continue
    stats.files++
    const cls = classifyFile(f.path, classifier)
    if (exemptClasses.includes(cls) || isIgnored(f.path)) { stats.exempt++; continue }

    const claimedBy = claimGlobs.filter((c) => c.test(f.path)).map((c) => ({ id: c.id, glob: c.glob, breadth: breadth(c) }))
    const isNew = f.status === "A" || f.status === "C"
    const surface = extractSurface(f.addedText ?? "", { class: cls })
    const surfaceClass = surfaceClasses.includes(cls)
    const route = surfaceClass ? routeOf(f.path) : null
    const addsSurface = surfaceClass && (isNew || surface.testIds.length > 0 || surface.exports.length > 0 || surface.httpMethods.length > 0)
    const tokens = addsSurface ? surfaceTokens({ path: f.path, class: cls, route, surface }) : []
    const specificClaim = claimedBy.some((c) => c.breadth <= broadThreshold)
    const mentions = tokens.filter(mentioned)

    let kind = null
    if (claimedBy.length === 0) kind = "unclaimed"
    else if (addsSurface && !specificClaim && mentions.length === 0) kind = "new-surface"
    else if (addsSurface && specificClaim) stats.exercisedBySpecificClaim++
    else if (addsSurface) stats.exercisedByMention++
    if (!kind) { stats.covered++; continue }

    const authors = [...new Map((authorsByFile[f.path] ?? []).map((a) => [`${a.email}\0${a.name}`, a])).values()]
      .map((a) => ({ name: a.name, email: a.email, own: authorIsOwn(a, ownAuthors) }))
    const foreign = authors.length === 0 || authors.some((a) => !a.own)
    gaps.push({
      key: `${kind}:${f.path}`, kind, path: f.path, ...(f.oldPath ? { oldPath: f.oldPath } : {}), status: f.status, class: cls, isNew,
      route, surface, tokens, claimedBy, specificClaim, authors, foreign, severity: foreign ? "red" : "warn",
    })
  }
  gaps.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "red" ? -1 : 1) || (a.kind === b.kind ? 0 : a.kind === "unclaimed" ? -1 : 1) || a.path.localeCompare(b.path))
  stats.gaps = gaps.length
  return { gaps, stats }
}

/* ─────────────────────────────────── ack ─────────────────────────────────── */

const sha256 = (s) => createHash("sha256").update(s).digest("hex")

/** Hash of the gap list a human looked at: kind, path, the file's bytes (blob id), severity. Order and time are not in it. */
export function gapsHash(gaps) {
  return sha256(gaps.map((g) => [g.kind, g.path, g.blob ?? "", g.severity ?? ""].join("\0")).sort().join("\n"))
}

export function makeAck({ gaps, by, note = "", at = new Date().toISOString(), base = "", head = "" }) {
  const items = gaps.map((g) => ({ key: `${g.kind}:${g.path}`, blob: g.blob ?? "" })).sort((a, b) => a.key.localeCompare(b.key))
  return { gapsHash: gapsHash(gaps), items, by, note, at, base, head }
}

/**
 * @returns {{status:"none"} | {status:"valid", ack:object} | {status:"stale", ack:object, added:string[], removed:string[], changed:string[]}}
 */
export function ackVerdict({ acks = [], gaps = [] }) {
  if (gaps.length === 0) return { status: "none" }
  const now = gapsHash(gaps)
  const match = [...acks].reverse().find((a) => a.gapsHash === now)
  if (match) return { status: "valid", ack: match }
  const last = acks.at(-1)
  if (!last) return { status: "none" }
  const before = new Map((last.items ?? []).map((i) => [i.key, i.blob]))
  const after = new Map(gaps.map((g) => [`${g.kind}:${g.path}`, g.blob ?? ""]))
  return {
    status: "stale", ack: last,
    added: [...after.keys()].filter((k) => !before.has(k)).sort(),
    removed: [...before.keys()].filter((k) => !after.has(k)).sort(),
    changed: [...after.keys()].filter((k) => before.has(k) && before.get(k) !== after.get(k)).sort(),
  }
}

/* ────────────────────────────────── drafts ────────────────────────────────── */

export const DEFAULT_DRAFT_TEMPLATE = `// DRAFT acceptance item "{{id}}" — written by \`vibeubi coverage-gap\`. It is not evidence and it does not run until a person finishes it.
// Why: {{why}}
// File: {{file}} ({{class}}, {{status}}); severity {{severity}}
// Commits:
{{commits}}
// TODO(plan): add { id: "{{id}}", covers: {{covers}}, after: {{after}} } to the acceptance plan, then delete this line.
// Selector suggestions (read from the changed file; confirm them in a real browser):
{{selectors}}
record("{{id}}", async () => {
  // TODO: open {{route}} and drive it the way a person would; assert on what they SEE, not on the markup you just read.
  // const el = page.locator('{{firstSelector}}')
  // await el.waitFor()
})
`

const commentLines = (lines) => (lines.length ? lines : ["(none found)"]).map((l) => `//   ${String(l).replace(/[\r\n]+/g, " ")}`).join("\n")

function draftId(gap) {
  if (gap.class === "component") return kebab(baseName(gap.path)) || "component"
  const rt = routeToken(gap.route)
  if (rt) return `${gap.class === "api" ? "api" : gap.class}-${kebab(rt)}`
  return kebab(gap.path.replace(/\.[^.]+$/, "")) || "item"
}

function selectorLines(gap) {
  const s = gap.surface ?? {}
  return [
    ...(s.testIds ?? []).map((id) => `[data-testid="${id}"]`),
    ...(s.ariaLabels ?? []).map((l) => `aria-label "${l}"`),
    ...(gap.route ? [`route ${gap.route}`] : []),
    ...(s.httpMethods ?? []).map((m) => `HTTP ${m}${gap.route ? " " + gap.route : ""}`),
    ...(s.apiCalls ?? []).map((u) => `calls ${u}`),
    ...(s.exports ?? []).map((n) => `component ${n}`),
  ]
}

const why = (gap) => gap.kind === "unclaimed"
  ? "no acceptance item claims this file at all"
  : `new ${gap.class} that no acceptance script exercises (claimed only by ${gap.claimedBy.map((c) => `${c.glob} [${c.breadth} files]`).join(", ") || "nothing"})`

/**
 * A `record()` skeleton for a gap. `templates` is a string, or `{ default?, <class>? }`; placeholders are
 * `{{id}} {{file}} {{class}} {{status}} {{kind}} {{severity}} {{why}} {{route}} {{selectors}} {{firstSelector}}
 * {{covers}} {{after}} {{commits}} {{methods}} {{apiCalls}} {{exports}}`. An unknown placeholder throws.
 *
 * @param {object} gap  a gap from `computeGaps`, optionally with `commits: {sha, author, subject}[]`
 */
export function draftFor(gap, templates) {
  const template = typeof templates === "string" ? templates : templates?.[gap.class] ?? templates?.default ?? DEFAULT_DRAFT_TEMPLATE
  const id = draftId(gap)
  const selectors = selectorLines(gap)
  const covers = [gap.path]
  const vars = {
    id, file: gap.path, class: gap.class, status: gap.status, kind: gap.kind, severity: gap.severity, why: why(gap),
    route: gap.route ?? "TODO-route", selectors: commentLines(selectors), firstSelector: selectors.find((s) => s.startsWith("[")) ?? "TODO-selector",
    covers: JSON.stringify(covers), after: "[]",
    commits: commentLines((gap.commits ?? []).map((c) => `${String(c.sha).slice(0, 7)} ${c.author}: ${c.subject}`)),
    methods: (gap.surface?.httpMethods ?? []).join(", "), apiCalls: (gap.surface?.apiCalls ?? []).join(", "), exports: (gap.surface?.exports ?? []).join(", "),
  }
  const source = template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, name) => {
    if (!(name in vars)) throw new Error(`unknown placeholder {{${name}}} in the draft template (known: ${Object.keys(vars).join(", ")})`)
    return vars[name]
  })
  return { id, fileName: `${id}.mjs`, source, covers, after: [], selectors: gap.surface ?? {} }
}
