import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { probe, renderConfig, findGateTokens } from "../src/probe.mjs"

async function fixture(files) {
  const dir = await mkdtemp(join(tmpdir(), "ubi-probe-"))
  for (const [p, text] of Object.entries(files)) {
    await mkdir(join(dir, p, ".."), { recursive: true })
    await writeFile(join(dir, p), text)
  }
  return dir
}

test("a helper defined but never called is surfaced, not buried in a count", () => {
  // The real one: verifyToken was written, exported and documented in a real
  // project, and referenced exactly once — inside its own doc comment.
  const t = findGateTokens(["export function verifyToken(req, res, next) {}"])
  const v = t.find((x) => x.name === "verifyToken")
  assert.equal(v.declared, true)
  assert.equal(v.uses, 0, "the declaration must not count as a use — that is what hides an unwired control")
  assert.equal(v.wired, false)
})

test("a helper that is actually wired counts higher", () => {
  const t = findGateTokens(["function requireAuth(){}", "router.get('/a', requireAuth, h)", "router.get('/b', requireAuth, h)"])
  const r = t.find((x) => x.name === "requireAuth")
  assert.equal(r.declared, true)
  assert.equal(r.uses, 2, "two call sites, and the declaration is not one of them")
  assert.equal(r.wired, true)
})

test("probe reads express shape off disk", async () => {
  const dir = await fixture({
    "package.json": JSON.stringify({ name: "x", dependencies: { express: "4" }, scripts: { build: "vite build", test: "vitest run" } }),
    "server/index.js": "const PORT = process.env.PORT || 3000;\napp.listen(PORT)",
    "server/routes/a.js": "router.get('/a', requireAuth, h)",
  })
  const p = await probe(dir)
  assert.equal(p.found.framework, "express")
  assert.equal(p.found.entry, "server/index.js")
  assert.equal(p.found.port, 3000)
  assert.equal(p.found.testRunner, "vitest")
  assert.equal(p.guessed.routesDir, "server/routes")
  await rm(dir, { recursive: true, force: true })
})

test("k8s beats Dockerfile when deciding the deploy shape", async () => {
  const dir = await fixture({ "package.json": "{}", "Dockerfile": "FROM node", "k8s/svc.yaml": "kind: Service" })
  assert.equal((await probe(dir)).found.deploy, "kubernetes")
  await rm(dir, { recursive: true, force: true })
})

test("proof is REFUSED, always — init never invents one", async () => {
  const dir = await fixture({ "package.json": JSON.stringify({ dependencies: { express: "4" } }), "server/index.js": "app.listen(3000)" })
  const p = await probe(dir)
  assert.equal(p.proof.status, "REFUSED")
  assert.match(p.proof.why, /no endpoint on this server echoes its own build/)
  await rm(dir, { recursive: true, force: true })
})

test("a /health route is offered as a CANDIDATE, not accepted as a proof", async () => {
  const dir = await fixture({
    "package.json": JSON.stringify({ dependencies: { express: "4" } }),
    "server/index.js": "app.get('/health', (q,s)=>s.send('ok'))",
  })
  const p = await probe(dir)
  assert.equal(p.proof.status, "REFUSED")
  assert.equal(p.proof.candidate, "/health")
  assert.match(p.proof.why, /returns the COMMIT or just/)
  await rm(dir, { recursive: true, force: true })
})

test("the rendered config marks guessed values and leaves versionPath commented out", async () => {
  const dir = await fixture({
    "package.json": JSON.stringify({ name: "y", dependencies: { express: "4" } }),
    "server/index.js": "app.listen(3000)",
  })
  const p = await probe(dir)
  const out = renderConfig(p, { adapterPath: "vibeubi/adapters/express.plugin.mjs" })
  assert.match(out, /GUESSED/)
  assert.match(out, /PROOF: REFUSED/)
  assert.match(out, /\/\/ versionPath/, "versionPath must be commented out, never filled in by a guess")
  await rm(dir, { recursive: true, force: true })
})

test("no auth helper found is said out loud, not left blank", async () => {
  const dir = await fixture({ "package.json": JSON.stringify({ dependencies: { express: "4" } }), "server/index.js": "app.listen(1)" })
  const out = renderConfig(await probe(dir), { adapterPath: "x" })
  assert.match(out, /EVERY route reads as ungated/)
  await rm(dir, { recursive: true, force: true })
})

test("a mention inside a doc comment is not a call site", () => {
  // The real one: verifyToken's only appearance outside its own declaration
  // was `* Usage: router.get('/protected', verifyToken, …)` in the comment
  // that explains how to use it. Counting that made an unwired control read
  // as wired.
  const src = [
    "/**",
    " * Usage: router.get('/protected', verifyToken, (req, res) => {})",
    " */",
    "export function verifyToken(req, res, next) {}",
  ].join("\n")
  const v = findGateTokens([src]).find((x) => x.name === "verifyToken")
  assert.equal(v.declared, true)
  assert.equal(v.uses, 0, "the doc comment is not a call site")
  assert.equal(v.wired, false)
})
