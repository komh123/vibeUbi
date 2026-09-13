#!/usr/bin/env node
/**
 * vibeubi — the CLI every harness can fall back to.
 *
 * Skills and AGENTS.md tell an agent what to think. This is what it runs, and
 * it is deliberately plain: node, no build step, no framework. A harness that
 * can spawn a process can use VibeUbi.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import {
  createContext, applyAll, capabilityCells, orphanVerdict, verdictFor,
  proofContract, deployProof, requiresHuman, rosterVerdict,
} from "../packages/kernel/src/index.mjs"
import { toIR, toMermaid, toArchify } from "../packages/viz/src/archify.mjs"

const argv = process.argv.slice(2)
const cmd = argv[0] ?? "help"
const flag = (n) => argv.includes(`--${n}`)
const val = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d }
const ROOT = resolve(val("root", process.cwd()))
const relativeish = (p) => p.startsWith(ROOT) ? p.slice(ROOT.length + 1) : p

const C = { dim: "\x1b[90m", red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m", bold: "\x1b[1m", off: "\x1b[0m" }
const say = (s = "") => console.log(s)
const ok = (s) => say(`  ${C.green}✓${C.off} ${s}`)
const bad = (s) => say(`  ${C.red}✗${C.off} ${s}`)
const note = (s) => say(`  ${C.dim}·${C.off} ${s}`)

async function loadConfig() {
  // `--config` lets a run point at a project WITHOUT writing a file into it —
  // which is what CI usually wants, and what you want the very first time you
  // scan somebody else's repo.
  const p = val("config", "") ? resolve(val("config", "")) : join(ROOT, "vibeubi.config.mjs")
  if (!existsSync(p)) return null
  return (await import(pathToFileURL(p).href)).default
}

async function boot() {
  const config = await loadConfig()
  if (!config) {
    bad("no vibeubi.config.mjs here.")
    note("run `vibeubi init` — or, in an agent, use the vibeubi-adopt skill.")
    process.exit(2)
  }
  const ctx = createContext()
  const plugins = []
  for (const spec of config.plugins ?? []) {
    const mod = typeof spec === "string" ? await import(pathToFileURL(resolve(ROOT, spec)).href) : spec
    plugins.push(mod)
  }
  const loaded = await applyAll(ctx, plugins, config.pluginConfig ?? {})
  return { config, ctx, loaded }
}

async function discoverAll(ctx) {
  const out = []
  for (const [kind, fn] of ctx.__registry.discoverers) {
    const r = await fn()
    if (r && r.__vibeubi_capability_failed) continue
    out.push(...(r ?? []))
  }
  return out
}

/* ───────────────────────────── commands ───────────────────────────── */

const COMMANDS = {
  async plan() {
    const { config, ctx, loaded } = await boot()
    say(`\n${C.bold}vibeubi plan${C.off} ${C.dim}${ROOT}${C.off}\n`)
    say(`${C.bold}plugins${C.off}`)
    for (const n of loaded.loaded) ok(n)
    for (const d of loaded.disabled) bad(`${d.owner} — ${d.why}`)

    say(`\n${C.bold}steps${C.off}`)
    for (const s of ["verify", "build", "swap", "prove", "sweep", "gate", "report"]) {
      const mutates = s === "swap" || s === "gate"
      say(`  ${mutates ? C.yellow + "mutates" + C.off : C.dim + "reads  " + C.off}  ${s}`)
    }

    say(`\n${C.bold}proof${C.off}`)
    const claim = ctx.__registry.target?.proofClaim
    if (!claim) bad("no deploy target registered — nothing can prove a deploy")
    else {
      const v = proofContract(claim)
      if (v.ok) ok(claim.source)
      else {
        bad(v.reason)
        note(claim.source)
        note("until this is wired, `ship` cannot tell a deploy that took from one that silently did not.")
      }
    }

    const discovered = await discoverAll(ctx)
    say(`\n${C.bold}surface${C.off}`)
    note(`${discovered.length} thing(s) discovered`)
    say("\nNothing was touched.\n")
  },

  async orphans() {
    const { config, ctx } = await boot()
    const discovered = await discoverAll(ctx)
    const v = orphanVerdict(discovered, config.declared ?? [], config.ignored ?? [])
    say(`\n${C.bold}vibeubi orphans${C.off}\n`)
    if (v.ok) { ok(v.reason); return }
    bad(v.reason)
    for (const o of v.orphans) say(`     ${C.yellow}orphan${C.off}  ${o.id}  ${C.dim}${o.source ?? ""}${C.off}`)
    for (const s of v.stale) say(`     ${C.yellow}stale ${C.off}  ${s.id}`)
    for (const u of v.unreasoned) say(`     ${C.red}no reason${C.off}  ${u.id}`)
    say(`\n${C.dim}Claim them with \`vibeubi adopt\`. Do NOT move them into \`ignored\` to`)
    say(`get a green light — that is a narrowing action and it needs a human.${C.off}\n`)
    process.exit(1)
  },

  async viz() {
    const { config, ctx } = await boot()
    const discovered = await discoverAll(ctx)
    const declaredById = new Map((config.declared ?? []).map((d) => [d.id, d]))
    const features = discovered.map((d) => ({ ...d, ...(declaredById.get(d.id) ?? {}) }))
    let cells = []
    const last = join(ROOT, ".vibeubi", "last-run.json")
    if (existsSync(last)) cells = JSON.parse(await readFile(last, "utf8")).cells ?? []

    const ir = toIR({
      title: config.name ?? "Coverage",
      features, cells,
      layers: config.layers ?? ["L0", "L1", "L2", "L3", "S"],
      exposure: config.exposure ?? [],
    })
    const fmt = val("format", "ir")
    const out = fmt === "mermaid" ? toMermaid(ir) : JSON.stringify(fmt === "archify" ? toArchify(ir) : ir, null, 2)
    process.stdout.write(out + "\n")
  },

  async roster() {
    const { config, ctx } = await boot()
    const live = config.tools ?? []
    const pins = config.toolPins ?? []
    const { findings } = rosterVerdict({ live, pins, declared: (config.declaredTools ?? []) })
    say(`\n${C.bold}vibeubi roster${C.off}  ${C.dim}${live.length} tool(s)${C.off}\n`)
    if (findings.length === 0) { ok("every tool is declared, pinned and clean"); return }
    for (const f of findings) {
      const col = f.severity === "critical" ? C.red : f.severity === "high" ? C.yellow : C.dim
      say(`  ${col}${f.severity.toUpperCase().padEnd(8)}${C.off} ${f.rule}  ${f.subject}`)
      say(`           ${f.title}`)
      say(`           ${C.dim}${f.why}${C.off}`)
    }
    process.exit(findings.some((f) => f.severity === "critical" || f.severity === "high") ? 1 : 0)
  },

  async scan() {
    const { config, ctx } = await boot()
    const { runScan } = await import("../packages/security/src/run.mjs")
    const base = val("base", config.base ?? "")
    const layers = val("layer", "S0,S1,S2,S4").split(",").map((x) => x.trim()).filter(Boolean)
    say(`\n${C.bold}vibeubi scan${C.off} ${C.dim}${ROOT} · ${layers.join(" ")}${base ? " · " + base : ""}${C.off}\n`)

    const discovered = await discoverAll(ctx)
    const r = await runScan({ root: ROOT, config, layers, base, discovered, note: (m) => note(m) })

    const order = { critical: 0, high: 1, medium: 2, low: 3, info: 4 }
    const col = { critical: C.red, high: C.yellow, medium: C.dim, low: C.dim, info: C.dim }
    const sorted = [...r.findings].sort((a, b) => order[a.severity] - order[b.severity])

    for (const fnd of sorted.slice(0, Number(val("max", "40")))) {
      say(`  ${col[fnd.severity] ?? ""}${fnd.severity.toUpperCase().padEnd(8)}${C.off} ${fnd.rule}`)
      say(`           ${fnd.title}`)
      say(`           ${C.dim}${fnd.where}${fnd.evidence ? "  ·  " + fnd.evidence : ""}${C.off}`)
    }
    if (sorted.length > Number(val("max", "40"))) note(`…and ${sorted.length - Number(val("max", "40"))} more`)

    const g = r.grade
    say(`\n  ${C.bold}grade ${g.grade}${C.off} ${C.dim}(score ${g.score})${C.off}  ·  ${r.findings.length} finding(s)  ·  ${r.counts}`)
    for (const s of r.skipped) note(`skipped ${s}`)
    if (r.precision < 1) note(`rule precision ${(r.precision * 100).toFixed(0)}% (${r.falsePositives} lexically-excluded match(es) dropped before you saw them)`)

    const out = join(ROOT, ".vibeubi"); await mkdir(out, { recursive: true })
    await writeFile(join(out, "scan.json"), JSON.stringify(r, null, 2))
    note(`written ${relativeish(join(out, "scan.json"))}`)
    process.exit(r.blocking.length > 0 ? 1 : 0)
  },

  async init() {
    const p = join(ROOT, "vibeubi.config.mjs")
    if (existsSync(p) && !flag("force")) { bad("vibeubi.config.mjs already exists (use --force)"); process.exit(2) }
    await writeFile(p, TEMPLATE, "utf8")
    ok(`wrote ${p}`)
    say(`\n${C.yellow}One field needs a human before this means anything: \`proof\`.${C.off}`)
    say(`${C.dim}It must be fetched from OUTSIDE the deployed process and must carry the`)
    say(`artifact id. An exit code from the thing that did the deploying is not a proof.${C.off}\n`)
  },

  async guard() {
    // Used by hooks: refuse a narrowing action that no human approved.
    const action = val("action", "")
    if (!action) { bad("guard needs --action"); process.exit(2) }
    if (!requiresHuman(action)) { ok(`${action} widens the check — allowed`); return }
    bad(`${action} NARROWS what gets checked — a human has to approve it.`)
    note("it makes a red light go away without fixing anything.")
    process.exit(1)
  },

  help() {
    say(`
${C.bold}vibeubi${C.off} — the gate that remembers so you do not have to

  ${C.bold}plan${C.off}      print what a run would do; touch nothing
  ${C.bold}orphans${C.off}   list what was discovered and nobody claimed
  ${C.bold}adopt${C.off}     write declarations for the orphans     ${C.dim}(agent skill)${C.off}
  ${C.bold}roster${C.off}    check the agent/MCP tool surface
  ${C.bold}viz${C.off}       export a diagram IR   --format ir|archify|mermaid
  ${C.bold}scan${C.off}      S0–S4 security layers  --layer S0,S1,S2,S4 [--base URL]
  ${C.bold}init${C.off}      write a vibeubi.config.mjs draft
  ${C.bold}guard${C.off}     --action <a>   refuse a narrowing action

${C.dim}--root DIR    where the project is
--config F    use this config instead of <root>/vibeubi.config.mjs
              (scan somebody else's repo without writing a file into it)${C.off}
`)
  },
}

const TEMPLATE = `/**
 * vibeubi.config.mjs
 *
 * Plugins are DSH-shaped: a module exporting \`name\` and \`apply(ctx, config)\`.
 */
import * as nextjs from "@vibeubi/adapters/nextjs.plugin.mjs"

export default {
  name: "my-app",
  plugins: [nextjs],
  pluginConfig: {
    "vibeubi-nextjs": { root: process.cwd(), probePath: "/" },
  },

  /** Roles the gate will exercise, weakest first. */
  roles: ["guest", "user", "admin"],

  /** Meaning. Everything discovered must appear here, in ignored, or be an orphan. */
  declared: [
    // { id: "page:/", area: "marketing", requiredRole: "guest", priority: "P1", testId: "app-home", intent: "" },
  ],

  /** Not features. Every entry needs a reason a reviewer would accept. */
  ignored: [
    // { id: "page:/_redirect", reason: "a redirect shim, nothing renders" },
  ],

  /** Deliberately unauthenticated endpoints. Every entry needs a reason. */
  publicApi: [
    // { id: "api:/api/version", reason: "no data; used by the deploy proof", expect: [200] },
  ],

  /** The agent surface. Pins are taken at approval time; drift is a rug pull. */
  tools: [],
  toolPins: [],
  declaredTools: [],
}
`

const fn = COMMANDS[cmd] ?? COMMANDS.help
Promise.resolve(fn()).catch((err) => {
  bad(err instanceof Error ? err.message : String(err))
  process.exit(3)
})
