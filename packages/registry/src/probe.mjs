/**
 * probe.mjs — what `ubi init` can work out on its own, and what it must not guess.
 *
 * The split matters more than the detection. Three kinds of answer:
 *
 *   FOUND    — read off the disk. Safe to write into a config.
 *   GUESSED  — inferred from a convention. Written in, and flagged, because a
 *              wrong convention is visible the first time `orphans` runs.
 *   REFUSED  — `proof`. It is the only field where a wrong answer produces no
 *              error anywhere else: the gate simply stops meaning anything. So
 *              init never invents one; it writes a comment saying what would
 *              count and leaves the field empty.
 */
import { readdir, readFile } from "node:fs/promises"
import { lex } from "../../security/src/collect.mjs"
import { existsSync } from "node:fs"
import { join } from "node:path"

const has = (root, p) => existsSync(join(root, p))
const read = async (root, p) => { try { return await readFile(join(root, p), "utf8") } catch { return "" } }

/** Auth helper names actually present in this codebase — not a fixed list.
 *  Guessing these is how a scanner ends up reporting every route as ungated. */
/**
 * Strip everything that is not executable code.
 *
 * Without this, `* Usage: router.get('/protected', verifyToken, …)` in a doc
 * comment counts as a call site — and a control whose ONLY mention is the
 * comment explaining how to use it reads as "wired ×1". That is the precise
 * false positive this project refuses elsewhere (`sourceScanHit`), so it does
 * not get a pass here.
 */
export function codeOnly(src) {
  return lex(src).filter((l) => l.region === "code").map((l) => l.text).join("\n")
}

export function findGateTokens(sources) {
  const defined = new Map()   // name → how many times it is DECLARED
  const called = new Map()    // name → how many times it is USED somewhere else

  const DEFINED = /\b(?:export\s+)?(?:async\s+)?function\s+(\w*[Aa]uth\w*|verify\w+|require\w+|ensure\w+|check\w+)\s*\(/g
  const CONST_DEF = /\b(?:export\s+)?const\s+(\w*[Aa]uth\w*|verify\w+|require\w+)\s*=\s*(?:async\s*)?\(/g
  const USED = /\b(requireAuth|authenticate|authMiddleware|verifyToken|verifyJwt|ensureAuthenticated|isAuthenticated|withAuth|requireUser|requireSession|checkAuth|auth)\b/g

  const bump = (m, k) => m.set(k, (m.get(k) ?? 0) + 1)

  for (const raw of sources) {
    const src = codeOnly(raw)
    for (const m of src.matchAll(DEFINED)) bump(defined, m[1])
    for (const m of src.matchAll(CONST_DEF)) bump(defined, m[1])
    for (const m of src.matchAll(USED)) bump(called, m[1])
  }

  // A declaration also matches as a mention, so subtract it. Without this,
  // `export function verifyToken(…)` counts 2 and reads as "wired twice" —
  // which hides the exact signal this probe exists to surface: a control that
  // was written, exported, documented, and never called by anything.
  const names = new Set([...defined.keys(), ...called.keys()])
  return [...names].map((name) => {
    const decls = defined.get(name) ?? 0
    const uses = Math.max(0, (called.get(name) ?? 0) - decls)
    return { name, uses, declared: decls > 0, wired: uses > 0 }
  }).sort((a, b) => b.uses - a.uses)
}

export async function probe(root) {
  const found = {}, guessed = {}, notes = []

  const pkgText = await read(root, "package.json")
  let pkg = {}
  try { pkg = JSON.parse(pkgText || "{}") } catch { notes.push("package.json is not valid JSON") }
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }
  found.name = pkg.name ?? null

  /* ── framework ── */
  if (deps.next) {
    found.framework = "nextjs"
    guessed.appDir = has(root, "app") ? "app" : has(root, "src/app") ? "src/app" : "app"
  } else if (deps.express) {
    found.framework = "express"
    for (const e of ["server/index.js", "server/index.mjs", "src/server.js", "index.js", "app.js", "server.js"]) {
      if (has(root, e)) { found.entry = e; break }
    }
    guessed.routesDir = ["server/routes", "src/routes", "routes"].find((d) => has(root, d)) ?? null
    guessed.pagesDir = ["client/src/pages", "src/pages", "app/pages"].find((d) => has(root, d)) ?? null
  } else if (has(root, "manage.py")) {
    found.framework = "django"
  } else if (deps.fastapi || has(root, "pyproject.toml")) {
    found.framework = "python"
  } else {
    found.framework = null
    notes.push("no framework recognised — write a discoverer, or point the generic adapter at your route table")
  }

  /* ── test runner ── */
  found.testCommand = pkg.scripts?.test ?? null
  // Read the script as well as the dependency list: a project can invoke a
  // runner it does not list, and the script is what actually runs.
  const testScript = pkg.scripts?.test ?? ""
  found.testRunner =
    deps.vitest || /\bvitest\b/.test(testScript) ? "vitest" :
    deps.jest || /\bjest\b/.test(testScript) ? "jest" :
    /node --test|node:test/.test(testScript) ? "node:test" :
    deps.mocha || /\bmocha\b/.test(testScript) ? "mocha" : null

  /* ── build / start ── */
  found.buildCommand = pkg.scripts?.build ?? null
  found.startCommand = pkg.scripts?.start ?? null

  /* ── deployment shape ── */
  found.deploy = has(root, "k8s") ? "kubernetes"
    : has(root, "docker-compose.yml") || has(root, "compose.yml") ? "compose"
    : has(root, "Dockerfile") ? "docker"
    : deps.next ? "filesystem-swap" : null

  /* ── port ── */
  const entryText = found.entry ? await read(root, found.entry) : ""
  const port = /PORT\s*\|\|\s*(\d{2,5})/.exec(entryText)?.[1] ?? /listen\(\s*(\d{2,5})/.exec(entryText)?.[1] ?? null
  if (port) found.port = Number(port)

  /* ── auth helpers actually present ── */
  const sources = []
  for (const dir of [guessed.routesDir, "server", "src", "app"].filter(Boolean)) {
    const d = join(root, dir)
    if (!existsSync(d)) continue
    let entries = []
    try { entries = await readdir(d, { withFileTypes: true }) } catch { continue }
    for (const e of entries.slice(0, 40)) {
      if (e.isFile() && /\.[mc]?[jt]sx?$/.test(e.name) && !/\.(test|spec)\./.test(e.name)) {
        sources.push(await read(root, join(dir, e.name)))
      }
    }
  }
  if (entryText) sources.push(entryText)
  found.gateTokens = findGateTokens(sources)

  /* ── the one thing init refuses to invent ── */
  const versionish = /['"`](\/(?:api\/)?(?:version|build|healthz?|_health))['"`]/.exec(entryText)?.[1] ?? null
  const proof = {
    status: "REFUSED",
    candidate: versionish,
    why: versionish
      ? `there is a ${versionish} route — check whether it returns the COMMIT or just "ok". Only the former can prove a deploy.`
      : "no endpoint on this server echoes its own build. Until one exists, ship cannot tell a deploy that took from one that silently did not.",
  }

  return { found, guessed, proof, notes }
}

/** Render a config from a probe. Guessed values carry a marker in a comment. */
export function renderConfig(p, { adapterPath }) {
  const f = p.found, g = p.guessed
  const cfg = f.framework === "express"
    ? `    "vibeubi-express": {
      root: process.cwd(),
      entry: ${JSON.stringify(f.entry ?? "server/index.js")},          // found
      routesDir: ${JSON.stringify(g.routesDir ?? "server/routes")},    // ${g.routesDir ? "found" : "GUESSED"}
      pagesDir: ${JSON.stringify(g.pagesDir ?? "src/pages")},          // ${g.pagesDir ? "found" : "GUESSED"}
      // versionPath: "/api/version",   ← see the proof note below
    },`
    : `    "vibeubi-nextjs": { root: process.cwd(), appDir: ${JSON.stringify(g.appDir ?? "app")} },`

  const tokens = f.gateTokens.length
    ? f.gateTokens.map((t) => `    ${JSON.stringify(t.name)},${t.uses === 1 ? "   // defined but used once — check it is actually wired" : ""}`).join("\n")
    : `    // none found. Until you name your auth helper, EVERY route reads as ungated.`

  return `/**
 * vibeubi.config.mjs — written by \`ubi init\`.
 *
 * Values marked GUESSED came from a convention, not from disk. They are safe
 * to be wrong: the first \`ubi orphans\` will show it immediately.
 *
 * ┌─ PROOF: ${p.proof.status} ${"─".repeat(Math.max(0, 52 - p.proof.status.length))}┐
 * │ ${p.proof.why}
 * │
 * │ init does not invent this field. It is the only one where a wrong answer
 * │ produces no error anywhere else — the gate simply stops meaning anything.
 * │ Two rules: the evidence is fetched from OUTSIDE the deployed process, and
 * │ it can contain the artifact id. An exit code from the thing that did the
 * │ deploying is not a proof.
 * └${"─".repeat(70)}┘
 */
import * as adapter from ${JSON.stringify(adapterPath)}

export default {
  name: ${JSON.stringify(f.name ?? "my-app")},
  plugins: [adapter],
  pluginConfig: {
${cfg}
  },

  /** Roles the gate will exercise, weakest first. */
  roles: ["guest", "user"],

  /** Auth helpers THIS project uses — read off your own source, not guessed. */
  gateTokens: [
${tokens}
  ],

  declared: [],
  ignored: [],      // every entry needs a reason
  publicApi: [],    // every entry needs a reason
  exposure: [],
  baseline: [],
}
`
}
