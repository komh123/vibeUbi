/**
 * vibeubi-express — discovery and proof for an Express + Vite/React app.
 *
 * Written against a real project (a system monitor: Express API, React client,
 * k8s). Two things here are not obvious and are where a naive scan gets it
 * wrong:
 *
 * 1. Routes live in TWO shapes and the second only makes sense combined:
 *      app.get("/api/metrics", …)                    in the entry file
 *      app.use("/api/chat", chatRoutes)  +  router.get("/sessions", …)
 *    The second pair is ONE route, `/api/chat/sessions`. Counting the halves
 *    separately gives you a registry that is wrong in both directions.
 *
 * 2. `router.get` in a *.test.js file is a fixture, not a route. Including it
 *    is exactly the false positive `sourceScanHit` refuses.
 */
import { readdir, readFile } from "node:fs/promises"
import * as target from "./process-target.mjs"
import { existsSync } from "node:fs"
import { join, relative, sep, basename } from "node:path"

export const name = "vibeubi-express"

const METHOD = "(get|post|put|patch|delete|all)"
const APP_ROUTE = new RegExp(`\\bapp\\.${METHOD}\\(\\s*['"\`]([^'"\`]+)['"\`]`, "g")
const ROUTER_ROUTE = new RegExp(`\\brouter\\.${METHOD}\\(\\s*['"\`]([^'"\`]+)['"\`]`, "g")
const MOUNT = /\bapp\.use\(\s*['"`]([^'"`]+)['"`]\s*,\s*(\w+)/g
const IMPORT = /(?:import\s+(\w+)\s+from|const\s+(\w+)\s*=\s*require\()\s*['"`]([^'"`]+)['"`]/g

const isTest = (p) => /\.(test|spec)\.[mc]?[jt]sx?$/.test(p)

async function ls(dir) {
  try { return await readdir(dir, { withFileTypes: true }) } catch { return [] }
}
async function walk(dir, out = []) {
  for (const e of await ls(dir)) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue
    const full = join(dir, e.name)
    if (e.isDirectory()) await walk(full, out)
    else out.push(full)
  }
  return out
}

export function apply(ctx, config = {}) {
  /** The id the current build stamped, before it has been swapped into place. */
  let _pendingId = null
  const root = config.root ?? process.cwd()
  const entry = join(root, config.entry ?? "server/index.js")
  const routesDir = join(root, config.routesDir ?? "server/routes")
  const pagesDir = join(root, config.pagesDir ?? "client/src/pages")

  if (!existsSync(entry)) return   // not an express project → silent no-op

  /** The entry file's own routes, plus the prefix each router is mounted at. */
  async function readEntry() {
    const src = await readFile(entry, "utf8")
    const direct = [...src.matchAll(APP_ROUTE)].map((m) => ({ method: m[1].toUpperCase(), path: m[2] }))

    // identifier → file
    const imports = new Map()
    for (const m of src.matchAll(IMPORT)) {
      const id = m[1] ?? m[2]
      if (id) imports.set(id, m[3])
    }
    const mounts = [...src.matchAll(MOUNT)].map((m) => ({ prefix: m[1], ident: m[2], file: imports.get(m[2]) ?? null }))
    return { src, direct, mounts }
  }

  ctx.discover("api", async () => {
    const { direct, mounts } = await readEntry()
    const byPath = new Map()
    const add = (path, method, source) => {
      const clean = path.replace(/\/+$/, "") || "/"
      const e = byPath.get(clean) ?? { id: `api:${clean}`, kind: "api", path: clean, methods: [], source }
      if (!e.methods.includes(method)) e.methods.push(method)
      byPath.set(clean, e)
    }

    for (const r of direct) add(r.path, r.method, relative(root, entry))

    for (const file of await walk(routesDir)) {
      if (isTest(file)) continue          // a fixture is not a route
      const rel = relative(root, file)
      const mount = mounts.find((m) => m.file && basename(m.file).replace(/\.[mc]?js$/, "") === basename(file).replace(/\.[mc]?js$/, ""))
      const prefix = mount?.prefix ?? ""
      if (!mount) ctx.note(`${rel}: not mounted anywhere in ${relative(root, entry)} — its routes are unreachable`)
      let src = ""
      try { src = await readFile(file, "utf8") } catch { continue }
      for (const m of src.matchAll(ROUTER_ROUTE)) {
        add(`${prefix}${m[2] === "/" ? "" : m[2]}` || "/", m[1].toUpperCase(), rel)
      }
    }
    return [...byPath.values()]
  })

  ctx.discover("page", async () => {
    const out = []
    for (const file of await walk(pagesDir)) {
      if (!/\.[jt]sx$/.test(file) || isTest(file)) continue
      const nm = basename(file).replace(/\.[jt]sx$/, "")
      out.push({
        id: `page:/${nm === "Home" || nm === "Index" ? "" : kebab(nm)}`,
        kind: "page", source: relative(root, file),
      })
    }
    return out
  })

  ctx.target({
    /* ── the three that change things ─────────────────────────────────── */
    async build() {
      if (!config.buildCommand) return { skipped: "no buildCommand configured" }
      const p = await target.build({ root, cmd: config.buildCommand, distDir: config.distDir ?? "dist" })
      // Stamp the id INTO the artifact. Without this the served version number
      // describes the working tree, and swapping the artifact back and forth
      // leaves it unchanged — a proof that cannot tell a rollback from a no-op.
      const { writeFile } = await import("node:fs/promises")
      const { execFile } = await import("node:child_process")
      const { promisify } = await import("node:util")
      const run = promisify(execFile)
      let commit = "nogit"
      try { commit = (await run("git", ["-C", root, "rev-parse", "--short", "HEAD"])).stdout.trim() } catch { /* no git */ }
      _pendingId = `${commit}-${Date.now()}`
      await writeFile(join(p.next, "BUILD_ID"), _pendingId, "utf8")
      return p
    },
    async swap() { return target.swap({ root, distDir: config.distDir ?? "dist" }) },
    async rollback() { return target.rollback({ root, distDir: config.distDir ?? "dist" }) },
    async restart() {
      if (!config.startCommand) return { skipped: "no startCommand configured" }
      return target.restart({ root, cmd: config.startCommand, env: config.env ?? {}, waitMs: config.startWaitMs ?? 1500 })
    },
    async stop() { return target.stop({ root }) },
    swapPlan() { return target.swapMoves(target.distPaths(root, config.distDir ?? "dist")) },

    /**
     * What is the RUNNING service serving right now?
     *
     * Asked before the swap, from outside, for the same reason `proof` is:
     * the id that matters for a rollback is the one the live process is
     * actually serving, not the one a file on disk claims. Without it a
     * rollback can move the files back and still not be provable — which is
     * the state this adapter shipped in for one run.
     */
    async previousArtifactId({ base, fetchImpl = fetch } = {}) {
      const url = base ?? config.base
      if (!config.versionPath || !url) return null
      try {
        const res = await fetchImpl(`${url}${config.versionPath}`, { signal: AbortSignal.timeout(4000) })
        const body = await res.text()
        return JSON.parse(body).build ?? null
      } catch { return null }   // nothing is running yet: a first deploy
    },

    /** The id this build stamped into its own artifact. */
    async artifactId() {
      if (_pendingId) return _pendingId
      try { return (await readFile(join(root, config.distDir ?? "dist", "BUILD_ID"), "utf8")).trim() } catch { return "" }
    },

    async _unusedArtifactId() {
      const { execFile } = await import("node:child_process")
      const { promisify } = await import("node:util")
      const run = promisify(execFile)
      const { stdout } = await run("git", ["-C", root, "rev-parse", "--short", "HEAD"])
      return stdout.trim()
    },
    /**
     * The claim must describe what this adapter can ACTUALLY do.
     *
     * The first version returned `{external: true, carriesArtifactId: true}`
     * unconditionally and put "NOT WIRED" in the human-readable `source`. So
     * `proofContract` passed and `vibeubi plan` printed a green tick next to
     * the words "NOT WIRED" — the adapter lied about its own ability to prove
     * anything, in the one field where a wrong answer produces no error
     * anywhere else. Caught on the first real project this was pointed at.
     */
    proofClaim: config.versionPath
      ? {
          external: true,
          carriesArtifactId: true,
          source: `GET ${config.versionPath} on the running server echoes the commit`,
        }
      : {
          external: false,
          carriesArtifactId: false,
          source: "no endpoint on this server echoes its own build — add one that returns the commit, then set `versionPath`",
        },
    async proof({ base, expected, previous, fetchImpl = fetch }) {
      if (!config.versionPath) {
        // Refusing loudly beats inventing a proof. A `proof` that cannot carry
        // the artifact id is the one mistake nothing else in the pipeline
        // reports, so it must be said here.
        return { expected, previous, observed: "" }
      }
      const res = await fetchImpl(`${base}${config.versionPath}`)
      return { expected, previous, observed: await res.text() }
    },
  })

  ctx.note(`express at ${relative(process.cwd(), root) || "."}`)
}

const kebab = (s) => s.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase()
