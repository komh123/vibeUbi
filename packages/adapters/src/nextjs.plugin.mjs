/**
 * vibeship-nextjs — a deploy target and a discoverer for a Next.js app.
 *
 * Shaped like a DSH/cordis plugin: `name` + `apply(ctx, config)`, loaded by
 * path, never throws into the host loop. Not configured → returns silently.
 */
import { readdir, readFile } from "node:fs/promises"
import { join, relative, sep } from "node:path"

export const name = "vibeship-nextjs"

const PAGE = /^page\.(tsx|ts|jsx|js)$/
const ROUTE = /^route\.(ts|js)$/

async function walk(dir, out = []) {
  let entries = []
  try { entries = await readdir(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue
    const full = join(dir, e.name)
    if (e.isDirectory()) await walk(full, out)
    else out.push(full)
  }
  return out
}

/** `app/(marketing)/[locale]/about/page.tsx` → `/[locale]/about` */
function routeOf(appDir, file) {
  const parts = relative(appDir, file).split(sep).slice(0, -1)
    .filter((p) => !(p.startsWith("(") && p.endsWith(")")))
    .filter((p) => !p.startsWith("@"))
  return "/" + parts.join("/")
}

export function apply(ctx, config = {}) {
  const root = config.root ?? process.cwd()
  const appDir = join(root, config.appDir ?? "app")

  // ── A · discovery ────────────────────────────────────────────────────
  ctx.discover("page", async () => {
    const files = await walk(appDir)
    return files.filter((f) => PAGE.test(f.split(sep).pop())).map((f) => ({
      id: `page:${routeOf(appDir, f)}`, kind: "page", source: relative(root, f),
    }))
  })

  ctx.discover("api", async () => {
    const files = await walk(appDir)
    const out = []
    for (const f of files.filter((x) => ROUTE.test(x.split(sep).pop()))) {
      let methods = []
      try {
        const src = await readFile(f, "utf8")
        methods = [...src.matchAll(/export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g)].map((m) => m[1])
      } catch { /* unreadable file: reported as a route with unknown methods */ }
      out.push({ id: `api:${routeOf(appDir, f)}`, kind: "api", source: relative(root, f), methods })
    }
    return out
  })

  // ── C · evidence ─────────────────────────────────────────────────────
  ctx.target({
    /** Next stamps BUILD_ID into the asset paths of every served page — which
     *  is why a served page can carry the proof at all. */
    async artifactId({ distDir = ".next" } = {}) {
      return (await readFile(join(root, distDir, "BUILD_ID"), "utf8")).trim()
    },
    proofClaim: {
      external: true,
      carriesArtifactId: true,
      source: "the running site's own HTML references /_next/<BUILD_ID>/…",
    },
    async proof({ base, expected, previous, fetchImpl = fetch }) {
      const res = await fetchImpl(`${base}${config.probePath ?? "/"}`, { redirect: "follow" })
      return { expected, previous, observed: await res.text() }
    },
  })

  ctx.note(`next.js target at ${relative(process.cwd(), root) || "."}`)
}
