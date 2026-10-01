import { test } from "node:test"
import assert from "node:assert/strict"
import { s0Secrets, s0Config, s2Routes, s2Sinks, s3Headers, s3Unauth, s4Exposure, stripStrings, mask, fingerprint } from "../src/rules.mjs"
import { lex } from "../src/collect.mjs"

// A real key carries its body; a base64 line long enough to be one (the value is random, not a key).
const PEM_BODY = "MIIEowIBAAKCAQEAq7Zp2Lm9Xc4Vb8Nh1Kj6Tw3Rf5Yd0GsQ7zP2lM9xC4vB8nH1kJ6"
const L = (text, n = 1) => ({ n, text, region: "code" })
const file = (path, lines) => ({ path, lines: lines.map((t, i) => L(t, i + 1)) })

test("a secret is never printed, only measured", () => {
  const [f] = s0Secrets({ files: [{ path: "a.env", text: "OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz123" }] })
  assert.ok(!f.evidence.includes("abcdefghij"), "the body must not appear anywhere in the output")
  assert.match(f.evidence, /\(\d+ chars\)/)
  assert.equal(mask("short"), "sh…(5 chars)")
})

test("history counts: a key deleted next commit is still a key", () => {
  const out = s0Secrets({ files: [], history: [{ commit: "abc1234", path: "k.yaml", text: `-----BEGIN RSA PRIVATE KEY-----\n${PEM_BODY}\n-----END RSA PRIVATE KEY-----` }] })
  assert.equal(out[0].rule, "S0.secret.history")
  assert.match(out[0].why, /Rotate it/)
})

test("placeholders are not credentials", () => {
  assert.equal(s0Secrets({ files: [{ path: ".env.example", text: 'password: "your-password-here"' }] }).length, 0)
  assert.equal(s0Secrets({ files: [{ path: "a.env", text: 'password: "xxxxxxxxxx"' }] }).length, 0)
})

test("fingerprints carry identity, not line numbers or dates", () => {
  const a = fingerprint("R", "f.js", "evidence on 2026-01-01")
  const b = fingerprint("R", "f.js", "evidence   on 2026-09-09")
  assert.equal(a, b, "a date change must not create a new finding")
})

test("COPY . . with no .dockerignore ships the working tree", () => {
  const out = s0Config({ dockerfiles: [{ path: "Dockerfile", text: "FROM node\nCOPY . .\n", hasDockerignore: false }] })
  assert.ok(out.some((f) => f.rule === "S0.dockerfile.copy_all"))
  assert.equal(s0Config({ dockerfiles: [{ path: "Dockerfile", text: "FROM node\nUSER app\nCOPY . .\n", hasDockerignore: true }] })
    .some((f) => f.rule === "S0.dockerfile.copy_all"), false)
})

test("a route neither gated nor declared public is an orphan", () => {
  const routes = [{ path: "/api/kill", methods: ["POST"], body: "res.send()" }]
  assert.equal(s2Routes({ routes, gateTokens: ["requireAuth"] })[0].rule, "S2.route.ungated")
  assert.equal(s2Routes({ routes: [{ path: "/api/kill", body: "requireAuth(req)" }], gateTokens: ["requireAuth"] }).length, 0)
})

test("an allow-list entry with no route behind it is how a rename escapes review", () => {
  const out = s2Routes({ routes: [], publicApi: [{ id: "api:/api/gone", reason: "public on purpose" }] })
  assert.equal(out[0].rule, "S2.allowlist.stale")
})

test("REGRESSION: log_secret matched prose at ~11% precision until it got a lexer", () => {
  // Nine hits on a real project, one real. The rest were the words "token"
  // and "secret" inside ordinary log messages.
  const noise = file("a.js", [
    "console.log('--- Turn 1: Set secret words ---');",
    "console.log('  Injected auth token into localStorage');",
    "console.log(`[TokenTracker] ${sessionId} prompt: ~${sysTokens} tokens`);",
    "console.error(`[Usage] Failed to read credentials for ${server.name}:`, e.message);",
  ])
  assert.equal(s2Sinks({ files: [noise] }).length, 0)

  const real = file("b.js", ["console.error('failed', accessToken);", "console.log('x', user.password);"])
  assert.equal(s2Sinks({ files: [real] }).length, 2)
})

test("innerHTML with a static literal is not XSS", () => {
  assert.equal(s2Sinks({ files: [file("a.js", ["el.innerHTML = 'Install App';"])] }).length, 0)
  assert.equal(s2Sinks({ files: [file("a.js", ["el.innerHTML = `<b>${name}</b>`;"])] }).length, 1)
})

test("a match in a comment never reaches a rule", () => {
  const lines = lex("// el.innerHTML = `${evil}`\nconst ok = 1\n").map((l, i) => ({ ...l, n: i + 1 }))
  assert.equal(s2Sinks({ files: [{ path: "a.js", lines }] }).length, 0)
})

test("a deliberate example in a test file is a fixture, not a finding", () => {
  assert.equal(s2Sinks({ files: [file("server/x.test.js", ["console.log('x', user.password);"])] }).length, 0)
})

test("stripStrings keeps ${} expressions and drops the prose around them", () => {
  assert.match(stripStrings("`total: ${count} tokens`"), /count/)
  assert.doesNotMatch(stripStrings("`total: ${count} tokens`"), /tokens/)
})

test("missing headers and a short HSTS", () => {
  assert.ok(s3Headers({ url: "u", headers: {} }).length >= 4)
  assert.ok(s3Headers({ url: "u", headers: { "strict-transport-security": "max-age=60" } })
    .some((f) => f.rule === "S3.tls.hsts_short"))
})

test("a 200 to a stranger is critical; a 5xx means auth was not first", () => {
  assert.equal(s3Unauth({ probes: [{ method: "GET", path: "/api/x", status: 200 }] })[0].rule, "S3.route.unauth_200")
  assert.equal(s3Unauth({ probes: [{ method: "GET", path: "/api/x", status: 500 }] })[0].rule, "S3.route.server_error")
  assert.equal(s3Unauth({ probes: [{ method: "GET", path: "/api/x", status: 401 }] }).length, 0)
})

test("an undeclared listener is the network's orphan", () => {
  const out = s4Exposure({ listeners: [{ service: "node", bind: "0.0.0.0", port: 3000 }] })
  assert.equal(out[0].rule, "S4.exposure.orphan")
  assert.equal(out[0].severity, "high")
})

test("declared AND open is still reported — it just has to be a decision", () => {
  const out = s4Exposure({
    listeners: [{ service: "node", bind: "0.0.0.0", port: 3000 }],
    declared: [{ service: "node", port: 3000, authRequired: false, reachableFrom: "internet", tls: false }],
  })
  assert.ok(out.some((f) => f.rule === "S4.exposure.unauthenticated_listener"))
  assert.ok(out.some((f) => f.rule === "S4.exposure.plaintext_public"))
})

test("a secret with a non-empty fallback literal is CRITICAL", () => {
  // Found live: a token signed with the repo's own default reached a
  // process-kill handler that had just been given an auth guard.
  const hit = s2Sinks({ files: [file("a.js", ["const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';"])] })
  assert.equal(hit.length, 1)
  assert.equal(hit[0].severity, "critical")
  assert.match(hit[0].rule, /default_secret/)
})

test("an empty fallback means unconfigured and fails closed — not a finding", () => {
  assert.equal(s2Sinks({ files: [file("a.js", ["const S = process.env.GOOGLE_CLIENT_SECRET || '';"])] }).length, 0)
})

test("a non-secret default is not a finding", () => {
  assert.equal(s2Sinks({ files: [file("a.js", ["const PORT = process.env.PORT || '3000';"])] }).length, 0)
})

test("generated output is never scanned — a finding nobody can act on", async () => {
  const { codeFiles } = await import("../src/collect.mjs")
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises")
  const { tmpdir } = await import("node:os")
  const { join } = await import("node:path")
  const dir = await mkdtemp(join(tmpdir(), "ubi-skip-"))
  await mkdir(join(dir, "dist-new"), { recursive: true })
  await writeFile(join(dir, "dist-new", "vendor.js"), "var a=1;".repeat(200) + "\nel.innerHTML=x")
  await writeFile(join(dir, "app.js"), "el.innerHTML = `${x}`")
  const { walk } = await import("../src/collect.mjs")
  const files = await walk(dir)
  const code = await codeFiles(dir, files)
  assert.deepEqual(code.map((c) => c.path), ["app.js"])
  await rm(dir, { recursive: true, force: true })
})

test("a route mounted behind a guard is gated — the rule must not punish the better practice", () => {
  // app.use('/api/chat', verifyToken, chatRoutes) guards all 28 routes behind
  // it. Reporting them as ungated pushes people to put a guard on every route
  // instead, which is exactly how the next route added starts out unguarded.
  const mounted = [{ path: "/api/chat/sessions", methods: ["GET"], body: "res.json([])", mountedBehind: ["verifyToken"] }]
  assert.equal(s2Routes({ routes: mounted, gateTokens: ["verifyToken"] }).length, 0)

  const unmounted = [{ path: "/api/chat/sessions", methods: ["GET"], body: "res.json([])", mountedBehind: ["compression"] }]
  assert.equal(s2Routes({ routes: unmounted, gateTokens: ["verifyToken"] })[0].rule, "S2.route.ungated")
})

test("REGRESSION: a multi-line template with no interpolation is not XSS", () => {
  // Real: an eight-line PWA update banner whose first line is a bare backtick.
  // Line-based reasoning cannot see where a template ends, so the rule flagged
  // every multi-line template it met.
  const staticBanner = file("pwa.js", [
    "banner.innerHTML = `",
    "  <div style=\"display:flex\">",
    "    <span>A new version is available.</span>",
    "    <button id='pwa-update-reload'>Reload</button>",
    "  </div>`;",
    "document.body.appendChild(banner)",
  ])
  assert.equal(s2Sinks({ files: [staticBanner] }).length, 0)

  const interpolated = file("x.js", [
    "el.innerHTML = `",
    "  <b>${userName}</b>`;",
  ])
  assert.equal(s2Sinks({ files: [interpolated] }).length, 1)
})

test("a template that never closes is reported, not cleared", () => {
  // Unknown must not read as safe.
  assert.equal(s2Sinks({ files: [file("x.js", ["el.innerHTML = `<b>"])] }).length, 1)
})

test("innerHTML from a variable is still reported", () => {
  assert.equal(s2Sinks({ files: [file("x.js", ["el.innerHTML = userHtml;"])] }).length, 1)
})

test("a page whose own assets 404 has not deployed, whatever the status line says", async () => {
  const { s2Assets, referencedAssets } = await import("../src/rules.mjs")
  const html = '<div id="root"></div><script src="/assets/index-abc.js"></script><link rel="stylesheet" href="/assets/index-abc.css">'
  const refs = referencedAssets(html)
  assert.deepEqual(refs, [{ href: "/assets/index-abc.js", kind: "script" }, { href: "/assets/index-abc.css", kind: "stylesheet" }])

  const broken = s2Assets({ url: "http://x/", html, assets: refs.map((r) => ({ ...r, status: 404 })) })
  assert.equal(broken.length, 2)
  assert.ok(broken.every((b) => b.severity === "critical"))

  const ok = s2Assets({ url: "http://x/", html,
    assets: [{ href: "/assets/index-abc.js", kind: "script", status: 200, type: "text/javascript" },
             { href: "/assets/index-abc.css", kind: "stylesheet", status: 200, type: "text/css" }] })
  assert.equal(ok.length, 0)
})

test("REGRESSION: 200 with the wrong content-type is the failure that actually happens", async () => {
  const { s2Assets } = await import("../src/rules.mjs")
  // Observed live: a wrong vite `base` made index.html reference /static/assets/…,
  // the SPA fallback answered every one of them 200 with text/html, and the page
  // sat on "Loading System Monitor…" forever. A status-code check passes this.
  const r = s2Assets({ url: "http://x/", html: '<script src="/static/assets/index-abc.js"></script>',
    assets: [{ href: "/static/assets/index-abc.js", kind: "script", status: 200, type: "text/html; charset=UTF-8" }] })
  assert.equal(r.length, 1)
  assert.equal(r[0].rule, "L2.assets.wrong_type")
  assert.equal(r[0].severity, "critical")
  assert.match(r[0].why, /SPA fallback/)
})

test("referencedAssets classifies what each reference is for", async () => {
  const { referencedAssets } = await import("../src/rules.mjs")
  const html = [
    '<link rel="preconnect" href="/nope">',
    '<link rel="stylesheet" href="/a.css">',
    '<link rel="icon" href="/i.png">',
    '<script src="https://cdn.example/x.js"></script>',
    '<script src="/app.js"></script>',
    '<img src="/p.png">',
  ].join("")
  assert.deepEqual(referencedAssets(html), [
    { href: "/a.css", kind: "stylesheet" },
    { href: "/i.png", kind: "other" },
    { href: "/app.js", kind: "script" },
    { href: "/p.png", kind: "image" },
  ])
})

test("assets referenced but never fetched is itself a finding", async () => {
  const { s2Assets } = await import("../src/rules.mjs")
  const r = s2Assets({ url: "http://x/", html: '<script src="/a.js"></script>', assets: [] })
  assert.equal(r[0].rule, "L2.assets.unchecked")
})

// A PEM header alone is not a private key (deploy 35 of Ava was refused on a fixture that BUILDS a key at run time:
// `-----BEGIN PRIVATE KEY-----\n${bodyLines.join("\n")}`). A real key always carries its body, so the rule needs one of:
//   · base64 on the next line · a `Proc-Type:` header (legacy encrypted PEM) · an escaped `\n` + base64 on the same line
//     (service-account JSON, env values) · base64 directly after the header on the same line.
// Changed in the rule, not whitelisted: the same fixture shape in any other file is judged the same way.
test("privkey: a PEM header counts only when a key body follows it — four shapes in, two out", () => {
  const ids = (path, text) => s0Secrets({ files: [{ path, text }] }).filter((f) => /privkey/.test(f.evidence)).length
  const BEGIN = "-----BEGIN PRIVATE KEY-----"

  // in
  assert.equal(ids("k.pem", `${BEGIN}\n${PEM_BODY}\n-----END PRIVATE KEY-----`), 1, "header + base64 on the next line")
  assert.equal(ids("k.pem", "-----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\nDEK-Info: AES-128-CBC,0123456789ABCDEF"), 1, "legacy encrypted PEM (Proc-Type)")
  assert.equal(ids("sa.json", `{"private_key": "${BEGIN}\\n${PEM_BODY}\\n-----END PRIVATE KEY-----\\n"}`), 1, "escaped one-line key (service-account JSON)")
  assert.equal(ids("k.txt", `${BEGIN} ${PEM_BODY}`), 1, "base64 straight after the header on the same line")

  // out
  const generated = "const block = `" + BEGIN + "\\n${bodyLines.join(\"\\n\")}\\n-----END PRIVATE KEY-----\\n`;"
  assert.equal(ids("scripts/lib/guards.mjs", generated), 0, "a header whose body is generated at run time is not a key")
  assert.equal(ids("k.pem", `${BEGIN}\n-----END PRIVATE KEY-----`), 0, "a bare header with nothing under it is not a key")
})

test("privkey: the other credential shapes are unaffected by the body rule", () => {
  assert.equal(s0Secrets({ files: [{ path: "a.env", text: "OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz123" }] }).length, 1)
  assert.equal(s0Secrets({ files: [{ path: "a.txt", text: "AKIAABCDEFGHIJKLMNOP" }] }).length, 1)
})
