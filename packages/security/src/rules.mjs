/**
 * rules.mjs — S0–S4, as pure functions over collected facts.
 *
 * Every rule here takes DATA and returns findings. The walking, the `git log`,
 * the `ss -ltnp` all live in collect.mjs. That split is not tidiness: it is the
 * only way these rules get unit tests, and an untested security rule is a rule
 * that reports a grade of F as a green row.
 *
 * Every finding carries `verdict:"real"` by default. A human who judges one a
 * false positive must fix the RULE — `baselineAdmission` refuses to absorb it.
 */
import { createHash } from "node:crypto"

export const fingerprint = (rule, where, evidence) =>
  createHash("sha256").update(JSON.stringify(['vibeubi-finding-v2', String(rule), String(where), normalise(evidence)])).digest("hex").slice(0, 32)

/** Line numbers move and timestamps always differ; neither may enter a fingerprint. */
const normalise = (s) => String(s ?? "").replace(/\s+/g, " ").replace(/\b\d{4}-\d{2}-\d{2}\b/g, "<date>").trim()

/** Never print a secret. A scanner that writes a key into a CI log IS an incident. */
export function mask(value) {
  const v = String(value ?? "")
  if (v.length <= 8) return `${v.slice(0, 2)}…(${v.length} chars)`
  return `${v.slice(0, 4)}…(${v.length} chars)`
}

const f = (rule, severity, where, title, evidence, why) =>
  ({ rule, severity, where, title, evidence, why, verdict: "real", fingerprint: fingerprint(rule, where, evidence) })

/**
 * The same constructor, exported.
 *
 * `run.mjs` had to raise one finding of its own and hand-built the object, with
 * `message:` where the shape says `title:` — so the report printed "undefined"
 * next to a real defect. A second way to build the same record is a second way
 * to get it wrong; there is now one.
 */
export const finding = f

/* ══════════════════ S0 · secrets and config ══════════════════ */

/**
 * Patterns are written with escapes only and anchored on the VALUE, not the
 * name — `API_KEY=` in an example file is documentation; `API_KEY=sk-live-…`
 * is an incident.
 */
export const SECRET_PATTERNS = [
  { id: "openai",   re: /\bsk-[A-Za-z0-9_-]{20,}/g,                            sev: "critical" },
  { id: "anthropic",re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g,                        sev: "critical" },
  { id: "aws",      re: /\bAKIA[0-9A-Z]{16}\b/g,                               sev: "critical" },
  { id: "github",   re: /\bgh[pousr]_[A-Za-z0-9]{30,}/g,                       sev: "critical" },
  { id: "slack",    re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,                     sev: "critical" },
  { id: "privkey",  re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g, sev: "critical", needsBody: true },
  { id: "jwt_hs",   re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, sev: "high" },
  { id: "gcp",      re: /"type"\s*:\s*"service_account"/g,                     sev: "critical" },
  { id: "pw_inline",re: /\b(?:password|passwd|secret|token)\s*[:=]\s*["'][^"'\s]{8,}["']/gi, sev: "high" },
]

/**
 * A PEM header alone is not a private key. A real key always carries its body: base64 on the next line, a `Proc-Type:`
 * header (legacy encrypted PEM), an escaped `\\n` followed by base64 on the same line (service-account JSON, env values), or
 * base64 straight after the header. A fixture that BUILDS a key at run time (`-----BEGIN PRIVATE KEY-----\\n${body}`) has none of
 * these — flagging it as a leaked key blocked Ava's deploy 35 (2026-10-01). The rule changes; no allow-list is added, so the
 * same shape anywhere else is judged the same way. `end` is the index just after the header in `text`.
 */
const BASE64_RUN = /[A-Za-z0-9+/]{40,}/
export function pemBodyFollows(text, end) {
  const rest = String(text).slice(end, end + 400)
  const escaped = /^[ \t]*(?:\\r)?\\n([A-Za-z0-9+/=]*)/.exec(rest)
  if (escaped) return BASE64_RUN.test(escaped[1])
  if (/^[ \t]*[A-Za-z0-9+/]{40,}/.test(rest)) return true
  const next = /^[ \t]*\r?\n[ \t]*([^\r\n]*)/.exec(rest)
  if (!next) return false
  const line = next[1].trim()
  return /^[A-Za-z0-9+/]{40,}={0,2}$/.test(line) || /^Proc-Type:/i.test(line)
}

/** A value that is obviously not a real credential. Keeps precision high —
 *  see textRuleFitness: a rule below 90% cannot gate. */
const PLACEHOLDER = /^(?:x{3,}|\.{3,}|<[^>]+>|\$\{[^}]+\}|your[_-]?|change[_-]?me|example|placeholder|dummy|test|sample|redacted|\*{3,})/i

export function s0Secrets({ files, history = [] }) {
  const out = []
  const scan = (where, text, inHistory) => {
    for (const p of SECRET_PATTERNS) {
      p.re.lastIndex = 0
      for (const m of String(text).matchAll(p.re)) {
        const val = m[0]
        if (p.needsBody && !pemBodyFollows(text, m.index + val.length)) continue
        if (PLACEHOLDER.test(val.replace(/^[A-Za-z_]+\s*[:=]\s*["']?/, ""))) continue
        out.push(f(
          inHistory ? "S0.secret.history" : "S0.secret.tree",
          p.sev, where,
          inHistory ? "a credential exists in git history" : "a credential is in the working tree",
          `${p.id} ${mask(val)}`,
          inHistory
            ? "a key deleted in the next commit is still a key: anyone who can clone can read it. Rotate it — rewriting history does not un-leak it"
            : "anything here ships in the image and in every clone",
        ))
      }
    }
  }
  for (const file of files) scan(file.path, file.text, false)
  for (const h of history) scan(`${h.commit} ${h.path}`, h.text, true)
  return dedupe(out)
}

export function s0Config({ trackedEnvFiles = [], dockerfiles = [], compose = [] }) {
  const out = []
  for (const p of trackedEnvFiles) {
    if (/\.example$|\.sample$|\.template$/.test(p)) continue
    out.push(f("S0.env.tracked", "high", p, "a real .env file is tracked by git", p,
      "it is in every clone and every image layer, and `git rm --cached` does not remove it from history"))
  }
  for (const d of dockerfiles) {
    if (!/^\s*USER\s+\S+/m.test(d.text)) {
      out.push(f("S0.dockerfile.no_user", "medium", d.path, "the image runs as root", "no USER directive",
        "a container escape starts as root, and nothing in this file says that was a decision"))
    }
    if (/^\s*COPY\s+\.\s/m.test(d.text) && !d.hasDockerignore) {
      out.push(f("S0.dockerfile.copy_all", "high", d.path, "`COPY . .` with no .dockerignore", "COPY . .",
        "the whole working tree goes into the image — including .env, .git, and whatever else is lying around"))
    }
  }
  for (const c of compose) {
    if (/\/var\/run\/docker\.sock/.test(c.text)) {
      out.push(f("S0.compose.docker_sock", "critical", c.path, "the docker socket is mounted into a container", "/var/run/docker.sock",
        "that is root on the host, handed to a process that is not supposed to have it"))
    }
    if (/privileged:\s*true/.test(c.text)) {
      out.push(f("S0.compose.privileged", "critical", c.path, "a privileged container", "privileged: true", "it drops nearly every isolation boundary"))
    }
  }
  return dedupe(out)
}

/* ══════════════════ S1 · dependencies ══════════════════ */

export function s1Audit({ advisories = [] }) {
  return dedupe(advisories.map((a) =>
    f("S1.npm_audit", String(a.severity ?? "low").toLowerCase(), a.name,
      `${a.name}: ${a.title ?? "known vulnerability"}`,
      `${a.name}@${a.range ?? "?"}${a.cve ? ` ${a.cve}` : ""}`,
      a.fixAvailable ? "a fix exists; this is debt with a known price" : "no fix published — this one needs a decision, not a bump")))
}

/**
 * The AIBOM: everything this system loads at runtime that a model will obey.
 * Not a vulnerability list — an inventory. You cannot pin what you have not
 * enumerated (OWASP Agentic ASI04).
 */
export function s1Aibom({ components = [] }) {
  return dedupe(components.filter((c) => !c.pinned).map((c) =>
    f("S1.aibom.unpinned", c.kind === "mcp" ? "high" : "medium", `${c.kind}:${c.name}`,
      `${c.kind} loaded at runtime with no pinned version or digest`, c.source ?? "",
      "an unpinned component can change under you between one run and the next, and the agent will obey the new one")))
}

/* ══════════════════ S2 · SAST ══════════════════ */

/**
 * Every route either gates itself or is named in the public allow-list.
 *
 * `gateTokens` is per project — this rule cannot know what your auth helper is
 * called, and guessing is how a scanner gets a 20% precision score.
 */
export function s2Routes({ routes, publicApi = [], gateTokens = [], declared = [] }) {
  const allowed = new Map(publicApi.map((p) => [p.id, p.reason]))
  /**
   * `requiredRole: "guest"` IS somebody saying this route is public.
   *
   * This rule used to read only `publicApi`, so on a real project ten routes
   * that a human had already declared reachable by a guest — /health,
   * /api/version, the SPA fallback, and every one of the five auth endpoints —
   * came back as "nobody declared this". Four of them are the LOGIN door: a
   * route that cannot be behind the gate it issues.
   *
   * A rule that flags a route for the thing its own declaration already says
   * is not strict, it is deaf, and it teaches people that the declaration does
   * not matter — which removes the whole point of axiom B.
   *
   * But `guest` is not the same statement as an allow-list entry: it says WHAT,
   * and an allow-list entry says WHY. So a guest route is not cleared, it is
   * re-asked as the narrower question — the one thing actually missing.
   */
  const declaredGuest = new Set(declared.filter((d) => d.requiredRole === "guest").map((d) => d.id))
  const out = []
  for (const r of routes) {
    // Guarded in the handler, OR mounted behind a guard. The second was missed
    // at first, so the moment this project did the RIGHT thing —
    // `app.use('/api/chat', verifyToken, chatRoutes)` — all 28 routes behind
    // that mount still read as ungated. A rule that punishes the better
    // practice teaches the worse one.
    const gatedInBody = gateTokens.some((t) => (r.body ?? "").includes(t))
    const gatedAtMount = (r.mountedBehind ?? []).some((mw) => gateTokens.includes(mw))
    const gated = gatedInBody || gatedAtMount
    const id = `api:${r.path}`
    if (gated) continue
    if (allowed.has(id)) {
      if (!String(allowed.get(id) ?? "").trim()) {
        out.push(f("S2.route.public_no_reason", "medium", id, "declared public with no reason", id,
          "a year from now nobody can tell whether this was a decision or an oversight"))
      }
      continue
    }
    if (declaredGuest.has(id)) {
      out.push(f("S2.route.public_no_reason", "medium", id,
        `${r.methods?.join("/") ?? "GET"} ${r.path} is declared reachable by a guest, but no reason is recorded`,
        r.source ?? r.path,
        "a year from now nobody can tell whether this was a decision or an oversight — move it to publicApi with one line of why"))
      continue
    }
    out.push(f("S2.route.ungated", "high", id,
      `${r.methods?.join("/") ?? "GET"} ${r.path} has no auth gate and is not in the allow-list`,
      r.source ?? r.path,
      "a route that neither gates itself nor is declared public is the security version of an orphan"))
  }
  // A listed path with no route behind it is how a public route survives a rename.
  const ids = new Set(routes.map((r) => `api:${r.path}`))
  for (const p of publicApi) {
    if (!ids.has(p.id)) {
      out.push(f("S2.allowlist.stale", "high", p.id, "the allow-list names a route that does not exist", p.id,
        "a rename leaves the exemption behind, pointing at nothing, while the renamed route is unguarded"))
    }
  }
  return dedupe(out)
}

/**
 * Sinks — and the reason each pattern is written the way it is.
 *
 * The first version of `log_secret` matched the WORD "token" or "secret"
 * anywhere in a `console.log(...)` call. Pointed at a real project it produced
 * nine hits, of which one was real:
 *
 *     console.log('--- Turn 1: Set secret words ---')        ← prose
 *     console.log('Injected auth token into localStorage')   ← prose
 *     console.log(colors.cyan('║ … Token Optimization … ║')) ← a banner
 *     console.error('[Auth] Token exchange failed:', tokens) ← REAL
 *
 * ~11% precision. `textRuleFitness` in the kernel refuses to let a rule below
 * 90% gate anything, and `baselineAdmission` refuses to absorb the noise — so
 * the only move left is the right one: give the rule a lexer.
 *
 * `stripStrings` removes string CONTENTS before an identifier-shaped pattern
 * is applied, so the rule now asks "is a secret-named VALUE being passed",
 * which is what it always claimed to ask.
 */
export function stripStrings(line) {
  let out = String(line)
  // Quoted strings vanish entirely.
  out = out.replace(/'(?:[^'\\]|\\.)*'/g, "''").replace(/"(?:[^"\\]|\\.)*"/g, '""')
  // Template literals: the PROSE goes, the ${...} expressions stay — they are
  // the only part that is an identifier. The first version left templates
  // alone whenever they contained a slot, so every word of prose around the
  // slot survived and matched.
  out = out.replace(/`([^`]*)`/g, (_, body) =>
    "`" + [...body.matchAll(/\$\{([^}]*)\}/g)].map((m) => m[1]).join(" ") + "`")
  return out
}

/**
 * Which names actually mean "a credential".
 *
 * `token` and `tokens` are NOT on this list, and that is a deliberate false
 * negative. In this codebase — and every LLM-adjacent codebase — "tokens" is a
 * unit of measurement: `${sysTokens} tokens`, `totalMessageTokens`,
 * `avgTokensPerMessage`. Keeping the bare word cost nine false positives out
 * of ten hits; dropping it costs one real finding
 * (`console.error('[Auth] Token exchange failed:', tokens)`).
 *
 * That trade is made on purpose, and this project's own doctrine says which
 * way to take it: a false negative is a hole, a false positive is a statement
 * somebody eventually signs for in a baseline. Compound names keep the real
 * ones that can be named without ambiguity.
 */
const SECRET_NAME = /\b(?:password|passwd|secret|secrets|apiKey|api_key|apiSecret|accessToken|refreshToken|authToken|idToken|bearerToken|sessionToken|privateKey|private_key|credential|credentials)\b/

export const SINK_PATTERNS = [
  {
    id: "inner_html", sev: "high",
    /**
     * Only when the assigned value is NOT a static literal.
     *
     * `el.innerHTML = 'Install App'` cannot be XSS, and reporting it is how a
     * rule loses the right to gate. The first version handled that for a
     * single line and then flagged every MULTI-LINE template — including an
     * eight-line PWA banner with no interpolation at all, whose first line is
     * just a bare backtick. Line-based reasoning cannot see where a template
     * ends, so this one gets the rest of the file.
     */
    needsText: true,
    test: (line, ctx) => {
      const m = /(?:dangerouslySetInnerHTML|\.innerHTML\s*=)\s*(.*)$/.exec(line)
      if (!m) return false
      const rhs = m[1].trim()
      if (/^['"][^'"]*['"]\s*;?$/.test(rhs)) return false            // a plain quoted literal
      if (!rhs.startsWith("`")) return true                           // a variable or a call
      // A template: read to its closing backtick, wherever that is.
      const body = templateBody(rhs.slice(1), ctx)
      return body === null ? true : /\$\{/.test(body)                // slots → interpolated
    },
    why: "unsanitised HTML reaches the DOM from a value that is interpolated, not a literal",
  },
  {
    id: "sql_raw", sev: "critical",
    test: (line) => /\b(?:query|execute|raw)\s*\(\s*[`'"][^`'"]*\$\{/.test(line),
    why: "a template literal interpolated into SQL — use parameters, not concatenation",
  },
  {
    id: "exec_interp", sev: "critical",
    test: (line) => /\b(?:exec|execSync|spawnSync)\s*\(\s*[`'"][^`'"]*\$\{/.test(line),
    why: "a shell command built by interpolation",
  },
  {
    id: "default_secret", sev: "critical",
    /**
     * A secret with a fallback literal is not a secret.
     *
     * Found live: `process.env.JWT_SECRET || 'your-secret-key-change-in-production'`.
     * That string is in the repository, so anyone who can read it can mint a
     * token every guard accepts — verified by signing one and reaching the
     * process-kill handler with it. Adding an auth check in front of a
     * destructive route while this line exists produces the appearance of a
     * control and none of the effect.
     *
     * An empty-string fallback (`|| ''`) is a different thing: it usually
     * means "unconfigured", which fails closed on its own. Only a non-empty
     * literal is reported.
     */
    test: (line) => {
      const m = /process\.env\.([A-Z0-9_]*(?:SECRET|TOKEN|KEY|PASSWORD|PASSWD|CREDENTIAL)[A-Z0-9_]*)\s*\|\|\s*(['"`])([^'"`]+)\2/.exec(line)
      if (!m) return false
      return m[3].trim().length > 0
    },
    why: "a secret falls back to a literal in the source — anyone who can read the repo has it, and every check that uses it becomes decoration",
  },
  {
    id: "log_secret", sev: "high",
    /** After the strings are hollowed out, a surviving match is an IDENTIFIER. */
    test: (line) => {
      const bare = stripStrings(line)
      return /console\.(?:log|info|warn|error|debug)\s*\(/.test(bare) && SECRET_NAME.test(bare)
    },
    why: "a secret-named value — not the word, the value — printed to a log that gets shipped somewhere",
  },
]

/**
 * @param {{files: readonly {path:string, lines: readonly {n:number, text:string, region:string}[]}[]}} input
 *   `region` comes from the lexer. A match in a comment or a string is a false
 *   positive, and `sourceScanHit` in the kernel says so by name.
 */
/**
 * Everything between here and the template's closing backtick.
 * `null` when it never closes in the lines we were given — unknown, so the
 * caller reports rather than clears it.
 */
function templateBody(firstLineRest, ctx) {
  if (firstLineRest.includes("`")) return firstLineRest.slice(0, firstLineRest.indexOf("`"))
  if (!ctx?.rest) return null
  let acc = firstLineRest
  for (const l of ctx.rest) {
    const i = l.indexOf("`")
    if (i >= 0) return acc + "\n" + l.slice(0, i)
    acc += "\n" + l
    if (acc.length > 8000) return null
  }
  return null
}

export function s2Sinks({ files, skipTests = true }) {
  const out = []
  for (const file of files) {
    // A deliberate example planted in a test is `test-fixture`, not a finding.
    if (skipTests && /\.(test|spec)\.|(^|\/)(tests?|e2e|__tests__)\//.test(file.path)) continue
    for (const line of file.lines) {
      if (line.region !== "code") continue
      for (const p of SINK_PATTERNS) {
        const ctx = p.needsText ? { rest: file.lines.slice(line.n).map((l) => l.text) } : null
        if (p.test(line.text, ctx)) {
          out.push(f(`S2.sink.${p.id}`, p.sev, `${file.path}:${line.n}`, p.why, line.text.trim().slice(0, 110), p.why))
        }
      }
    }
  }
  return dedupe(out)
}

/* ══════════════════ S3 · DAST ══════════════════ */

export const REQUIRED_HEADERS = [
  ["strict-transport-security", "high",   "without HSTS a single plaintext request downgrades the whole session"],
  ["x-content-type-options",    "medium", "without nosniff the browser may execute what you served as data"],
  ["x-frame-options",           "medium", "without it the page can be framed and clickjacked"],
  ["content-security-policy",   "high",   "no CSP means any injected script runs with full privileges"],
  ["referrer-policy",           "low",    "full URLs leak to third parties"],
]

export function s3Headers({ url, headers }) {
  const have = new Map(Object.entries(headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]))
  const out = []
  for (const [h, sev, why] of REQUIRED_HEADERS) {
    if (!have.has(h)) out.push(f("S3.headers.missing", sev, url, `${h} is not set`, h, why))
  }
  const hsts = have.get("strict-transport-security")
  if (hsts) {
    const age = Number(/max-age=(\d+)/.exec(hsts)?.[1] ?? 0)
    if (age < 15_552_000) out.push(f("S3.tls.hsts_short", "medium", url, `HSTS max-age is ${age}s`, hsts,
      "under six months it is too short to survive a preload submission or a returning visitor"))
  }
  return dedupe(out)
}

export function s3Unauth({ probes, publicApi = [] }) {
  const allowed = new Map(publicApi.map((p) => [p.id, p.expect ?? [200]]))
  const out = []
  for (const p of probes) {
    const id = `api:${p.path}`
    if (p.status >= 500) {
      out.push(f("S3.route.server_error", "high", id, `${p.method} ${p.path} answered ${p.status} unauthenticated`, String(p.status),
        "a 5xx on an unauthenticated request means the handler ran far enough to break — the auth check is not first"))
      continue
    }
    const ok = [401, 403, 404].includes(p.status) || (allowed.get(id) ?? []).includes(p.status)
    if (!ok) {
      out.push(f("S3.route.unauth_200", "critical", id, `${p.method} ${p.path} answered ${p.status} with no credentials`, String(p.status),
        "this endpoint served something to a stranger, and nothing declared it public"))
    }
  }
  return dedupe(out)
}

export function s3Cors({ url, origin, allowOrigin, allowCredentials }) {
  const out = []
  if (allowOrigin === "*" && allowCredentials) {
    out.push(f("S3.cors.wildcard_creds", "critical", url, "CORS allows any origin AND credentials", "* + credentials",
      "any site can make authenticated requests as your logged-in user"))
  } else if (allowOrigin && origin && allowOrigin === origin) {
    out.push(f("S3.cors.reflected", "high", url, `CORS reflected an arbitrary origin (${origin})`, allowOrigin,
      "reflecting the request's own Origin is the same as allowing everything, with extra steps"))
  }
  return dedupe(out)
}

/**
 * The page returns 200 and every asset it references is a 404.
 *
 * A documented failure mode, not a hypothetical: a build written to the wrong
 * output directory emptied the live static folder, the home page kept
 * answering 200, and every chunk 500'd. `deployProof` passes — the served HTML
 * carries the new artifact id — and the site is blank.
 *
 * This is the cheapest check that catches it: read the HTML the deploy is
 * actually serving, take every script/link/img it references, and fetch them.
 * A page whose own assets do not resolve has not deployed, whatever the
 * status line says.
 *
 * P0 by nature. There is no version of "some of the JavaScript is missing"
 * that is a non-blocking finding.
 */
const EXPECTED_TYPE = {
  script: /javascript|ecmascript|application\/json/i,
  stylesheet: /text\/css/i,
  image: /^image\//i,
}

export function s2Assets({ url, html, assets }) {
  const out = []
  if (assets.length === 0 && /<script|<link/i.test(html)) {
    out.push(f("L2.assets.unchecked", "high", url, "the page references assets and none were fetched", "",
      "an unchecked reference is not a passing one"))
  }
  for (const a of assets) {
    if (a.status >= 400) {
      out.push(f(a.status >= 500 ? "L2.assets.server_error" : "L2.assets.missing", "critical", `${url} → ${a.href}`,
        `the page references ${a.href} and it answers ${a.status}`, String(a.status),
        "the page is serving, and the code it needs to run is not. 200 on the document says nothing about this."))
      continue
    }
    /**
     * A 200 is not enough, and this is the version that actually happens.
     *
     * An SPA fallback answers ANY unmatched path with index.html — so a wrong
     * `base`, or a chunk that never got written, comes back 200 with
     * `content-type: text/html`. The browser is handed HTML where it expected
     * JavaScript, the script never executes, and the page sits on its loading
     * text forever.
     *
     * Observed exactly that: document 200, script 200, type text/html, page
     * blank. A status-code check passes it. This is the same shape as every
     * other rule in this project — the absence of bad news is not good news.
     */
    const want = EXPECTED_TYPE[a.kind]
    if (want && a.type && !want.test(a.type)) {
      out.push(f("L2.assets.wrong_type", "critical", `${url} → ${a.href}`,
        `${a.kind} ${a.href} answered 200 with content-type ${a.type.split(";")[0]}`,
        a.type.split(";")[0],
        "almost certainly the SPA fallback answering for a file that is not there. The status line says 200 and the browser gets HTML where it expected code."))
    }
  }
  return dedupe(out)
}

/** Every src/href the document actually depends on to render. */
export function referencedAssets(html) {
  const out = new Map()
  for (const m of String(html).matchAll(/<(script|link|img)\b([^>]*?)>/gi)) {
    const [tag, attrs] = [m[1].toLowerCase(), m[2]]
    const href = /\b(?:src|href)=["']([^"']+)["']/i.exec(attrs)?.[1]
    if (!href) continue
    if (/^(?:https?:)?\/\//.test(href) || href.startsWith("data:") || href.startsWith("#")) continue
    const rel = /\brel=["']?([\w-]+)/i.exec(attrs)?.[1]?.toLowerCase()
    if (tag === "link" && !["stylesheet", "icon", "apple-touch-icon", "manifest"].includes(rel ?? "")) continue
    const kind = tag === "script" ? "script"
      : tag === "img" ? "image"
      : rel === "stylesheet" ? "stylesheet"
      : "other"
    out.set(href.startsWith("/") ? href : "/" + href, kind)
  }
  return [...out.entries()].map(([href, kind]) => ({ href, kind }))
}

/* ══════════════════ S4 · exposure map ══════════════════ */

/**
 * The registry, re-pointed at the network.
 *
 * A listener reachable from anywhere that requires no auth IS an orphan: it
 * exists, and nobody claimed responsibility for it.
 */
/**
 * @param {object} o
 * @param {boolean} [o.canObserve] whether this scan is standing somewhere the
 *   declared listeners could be seen at all. Scanning a k8s app from a laptop
 *   sees none of its Services — and reporting that as `stale` asserts a fact
 *   ("it is not listening") that the scan never established. Same empty
 *   observation, opposite fixes, and the wrong one sends someone to delete a
 *   declaration that was right.
 */
export function s4Exposure({ listeners, declared = [], canObserve = true }) {
  const claimed = new Map(declared.map((d) => [`${d.service}:${d.port}`, d]))
  const out = []
  for (const l of listeners) {
    const key = `${l.service}:${l.port}`
    const d = claimed.get(key)
    const publicBind = l.bind === "0.0.0.0" || l.bind === "::" || l.bind === "*"

    if (!d) {
      out.push(f("S4.exposure.orphan", publicBind ? "high" : "medium", key,
        `${l.service} listens on ${l.bind}:${l.port} and nobody declared it`, `${l.bind}:${l.port} ${l.process ?? ""}`,
        "an undeclared listener is the network version of an orphan feature"))
      continue
    }
    if (publicBind && d.authRequired === false) {
      out.push(f("S4.exposure.unauthenticated_listener", "high", key,
        `${l.service} is reachable from any interface and requires no auth`, `${l.bind}:${l.port}`,
        "declared, but declared as open — this needs to be a decision someone made on purpose"))
    }
    if (publicBind && d.tls === false && d.reachableFrom === "internet") {
      out.push(f("S4.exposure.plaintext_public", "high", key, `${l.service} is on the public internet without TLS`, `${l.bind}:${l.port}`,
        "credentials and session cookies cross the network in the clear"))
    }
  }
  for (const d of declared) {
    if (listeners.some((l) => `${l.service}:${l.port}` === `${d.service}:${d.port}`)) continue
    out.push(
      canObserve
        ? f("S4.exposure.stale", "low", `${d.service}:${d.port}`, "a declared listener is not listening", `${d.service}:${d.port}`,
            "either it is down, or the declaration outlived the service")
        // Not a finding about the system — a finding about the scan.
        : f("S4.exposure.unobservable", "info", `${d.service}:${d.port}`,
            "this scan cannot see where this listener lives, so nothing is claimed about it",
            `${d.service}:${d.port}`,
            "run the scan from somewhere that can reach it, or this row is permanently unmeasured"),
    )
  }
  return dedupe(out)
}

function dedupe(findings) {
  const seen = new Set()
  return findings.filter((x) => !seen.has(x.fingerprint) && seen.add(x.fingerprint))
}
