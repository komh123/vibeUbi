/**
 * roster.mjs — the agent's tool surface, held to the same three axioms.
 *
 * This is where VibeUbi's security model stops being a port of ordinary
 * appsec and starts being about agents.
 *
 * THE INSIGHT: an agent's tool list is a REGISTRY. It has exactly the same
 * three problems a feature registry has, and therefore exactly the same three
 * answers:
 *
 *   A · discovery  — enumerate every tool the agent can actually reach
 *   B · declaration— a tool nobody declared is an ORPHAN
 *   C · evidence   — pin the bytes; a definition that changed is DRIFT
 *
 * WHY PINNING IS THE WHOLE GAME. MCP clients inherit trust from the servers
 * they connect to and then never verify it again. A server can be approved on
 * Monday and ship a new tool description on Tuesday — the rug pull. Nothing in
 * the protocol notices. A hash taken at approval time is the only thing that
 * does. (OWASP Agentic ASI04, supply chain; ASI02, tool misuse.)
 *
 * Pure functions. The collection of the roster is an adapter's job.
 */

import { createHash } from "node:crypto"

/** @typedef {{server:string, name:string, description?:string, inputSchema?:unknown}} Tool */

/**
 * The identity of a tool definition, as the MODEL sees it.
 *
 * Name, description and parameter schema — because all three reach the model
 * as trusted operational context, and a change in ANY of them changes what the
 * agent will do. Nothing else is included: server version strings and
 * transport details move for innocent reasons and would make every pin stale.
 */
export function toolFingerprint(tool) {
  const canon = JSON.stringify({
    name: tool.name,
    description: tool.description ?? "",
    inputSchema: stable(tool.inputSchema ?? null),
  })
  return createHash("sha256").update(canon).digest("hex").slice(0, 32)
}

function stable(v) {
  if (Array.isArray(v)) return v.map(stable)
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.keys(v).sort().map((k) => [k, stable(v[k])]))
  }
  return v
}

export const toolKey = (t) => `${t.server}/${t.name}`

/* ─────────────────────────── C · evidence ─────────────────────────── */

/**
 * Compare the live roster against what was approved.
 *
 * Four outcomes, and the middle two are the ones no other tool reports:
 *   added    — a tool appeared after approval          (INFO; declare it)
 *   CHANGED  — same tool, different bytes → RUG PULL   (CRITICAL)
 *   removed  — a tool the agent was told it has is gone(MEDIUM; stale pin)
 *   pinned   — unchanged
 *
 * @param {readonly Tool[]} live
 * @param {readonly {key:string, fingerprint:string}[]} pins
 */
export function rosterDrift(live, pins) {
  const pinned = new Map(pins.map((p) => [p.key, p.fingerprint]))
  const seen = new Set()
  const added = [], changed = [], unchanged = []

  for (const t of live) {
    const key = toolKey(t)
    seen.add(key)
    const fp = toolFingerprint(t)
    const was = pinned.get(key)
    if (was === undefined) { added.push({ key, fingerprint: fp, tool: t }); continue }
    if (was !== fp) { changed.push({ key, from: was, to: fp, tool: t }); continue }
    unchanged.push({ key, fingerprint: fp })
  }

  const removed = pins.filter((p) => !seen.has(p.key)).map((p) => p.key)
  return { added, changed, removed, unchanged }
}

/**
 * Two servers exposing the same tool name. The agent picks one; you do not
 * get to know which, and the loser may be the one you audited. (Tool shadowing.)
 * @param {readonly Tool[]} live
 */
export function shadowedTools(live) {
  const byName = new Map()
  for (const t of live) {
    const list = byName.get(t.name) ?? []
    list.push(t.server)
    byName.set(t.name, list)
  }
  return [...byName.entries()]
    .filter(([, servers]) => new Set(servers).size > 1)
    .map(([name, servers]) => ({ name, servers: [...new Set(servers)] }))
}

/* ─────────────────────── poisoned descriptions ────────────────────── */

/**
 * Text that reaches the model as instructions but arrives as "metadata".
 *
 * Each pattern is here because it has been seen in a real disclosed attack,
 * not because it sounded plausible. Ordered by how hard they are to notice by
 * reading: the invisible ones first.
 */
export const POISON_PATTERNS = [
  // Escapes only, never literal characters. The first version of this list was
  // written with the real code points pasted in, and a shell heredoc ate the
  // astral ones — leaving `[\u0030-\u0046]`, a range that matches any digit.
  // Every clean tool on earth was CRITICAL. A rule you cannot see is a rule you
  // cannot review, so the bytes are spelled out and a test asserts it.
  { id: "zero_width",  severity: "high",     re: /[\u200B-\u200F\u2060\uFEFF]/,                 why: "zero-width characters — text a reviewer cannot see but the model reads" },
  { id: "bidi",        severity: "high",     re: /[\u202A-\u202E\u2066-\u2069]/,                why: "bidirectional overrides — the rendered order differs from the byte order" },
  { id: "tag_chars",   severity: "critical", re: /[\u{E0000}-\u{E007F}]/u,                       why: "Unicode tag characters — an entire invisible instruction channel" },
  { id: "override",    severity: "critical", re: /\b(ignore|disregard|forget)\s+(all\s+)?(previous|prior|above|earlier)\b/i, why: "an instruction override aimed at the system prompt" },
  { id: "important",   severity: "high",     re: /<\s*(IMPORTANT|SYSTEM|CRITICAL)\s*>/i,          why: "a fake system-priority block inside tool metadata" },
  { id: "exfil_url",   severity: "critical", re: /https?:\/\/[^\s)"']*[?&#][^\s)"']*(\{\{|\$\{|%s|<[a-z_]+>)/i, why: "a URL with a template slot — an exfiltration sink waiting for your data" },
  { id: "md_image",    severity: "high",     re: /!\[[^\]]*\]\(\s*https?:\/\/[^)]*(\{\{|\$\{|%s)/i, why: "an auto-fetched markdown image with interpolation — the EchoLeak shape" },
  { id: "read_secret", severity: "critical", re: /\b(\.env|id_rsa|credentials?|api[_-]?keys?|secrets?)\b[^.\n]{0,40}\b(read|cat|send|post|upload|include|attach)\b/i, why: "metadata that asks the agent to read credentials" },
  { id: "silence",     severity: "critical", re: /\b(do not|do n.t|don.t|never)\s+(mention|tell|reveal|inform|show|disclose)\b[^.\n]{0,40}\b(user|human|anyone|them)\b/i, why: "an instruction to hide its own activity from the user — the EchoLeak email did exactly this" },
]

/**
 * Every pattern must be written with escapes, not pasted code points.
 * Exported so a test can hold the line: see the comment above for the bug.
 */
export function patternsAreEscapeOnly() {
  const bad = POISON_PATTERNS.filter((p) => /[^\x00-\x7F]/.test(p.re.source))
  return { ok: bad.length === 0, bad: bad.map((p) => p.id) }
}

/**
 * @param {Tool} tool
 * @returns {{id:string, severity:string, why:string, where:string}[]}
 */
export function poisonFindings(tool) {
  const fields = [
    ["description", tool.description ?? ""],
    ["inputSchema", JSON.stringify(tool.inputSchema ?? "")],
  ]
  const out = []
  for (const [where, text] of fields) {
    for (const p of POISON_PATTERNS) {
      if (p.re.test(text)) out.push({ id: p.id, severity: p.severity, why: p.why, where })
    }
  }
  return out
}

/* ─────────────────────────── the whole verdict ─────────────────────── */

/**
 * @param {{live:readonly Tool[], pins:readonly {key:string,fingerprint:string}[], declared:readonly string[]}} input
 */
export function rosterVerdict({ live, pins, declared = [] }) {
  const drift = rosterDrift(live, pins)
  const declaredSet = new Set(declared)
  const findings = []

  for (const c of drift.changed) {
    findings.push({
      rule: "S5.mcp.rug_pull", severity: "critical", subject: c.key,
      title: "a tool definition changed after it was approved",
      evidence: `${c.from} → ${c.to}`,
      why: "the agent was approved against different bytes than the ones it is now being sent",
    })
  }
  for (const a of drift.added) {
    findings.push({
      rule: declaredSet.has(a.key) ? "S5.mcp.unpinned" : "S5.mcp.orphan",
      severity: declaredSet.has(a.key) ? "medium" : "high",
      subject: a.key,
      title: declaredSet.has(a.key) ? "declared but never pinned" : "a tool nobody declared is reachable by the agent",
      evidence: a.fingerprint,
      why: "an unclaimed tool is the agent-surface version of an orphan feature: it exists, and no one is accountable for it",
    })
  }
  for (const key of drift.removed) {
    findings.push({
      rule: "S5.mcp.stale_pin", severity: "medium", subject: key,
      title: "a pinned tool is gone from the live roster",
      evidence: "", why: "a pin with no tool behind it is how a rename survives review",
    })
  }
  for (const s of shadowedTools(live)) {
    findings.push({
      rule: "S5.mcp.shadowed", severity: "high", subject: s.name,
      title: `the same tool name is served by ${s.servers.length} servers`,
      evidence: s.servers.join(", "),
      why: "the agent resolves one of them and you do not get to know which; the loser may be the one you audited",
    })
  }
  for (const t of live) {
    for (const f of poisonFindings(t)) {
      findings.push({
        rule: `S5.mcp.poison.${f.id}`, severity: f.severity, subject: toolKey(t),
        title: f.why, evidence: `in ${f.where}`,
        why: "tool metadata reaches the model as trusted operational context",
      })
    }
  }
  return { drift, findings }
}
