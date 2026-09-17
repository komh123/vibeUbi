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
const { SHIP_STEPS } = await import("../packages/ship/src/run.mjs")
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
    // Both the list AND the property come from SHIP_STEPS. The first version
    // of this fix derived the list and left `mutates` hardcoded, so `probe`
    // printed "reads" while its definition said it mutates — the number right
    // and the field next to it still saying the old thing.
    for (const s of SHIP_STEPS) {
      say(`  ${s.mutates ? C.yellow + "mutates" + C.off : C.dim + "reads  " + C.off}  ${s.id}`)
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

  /**
   * `probe` — drive the skill step on its own.
   *
   * Without this the step is only reachable through a whole ship, which is
   * minutes of build and tests before the agent can see whether the order is
   * even right. Two halves: `--order` writes what to check, `--judge` reads
   * what came back. The judging is identical to the one inside ship, because
   * it is the same kernel function — a second implementation of the verdict is
   * how the standalone path and the pipeline start disagreeing.
   */
  async probe() {
    /**
     * No-config mode: `--declared <file>` with `--base` and `--artifact`.
     *
     * A peer tried this step on a repo that has not adopted vibeubi and the
     * first line back was "no vibeubi.config.mjs here" — so trying ONE step
     * required making the whole adoption decision first. Those are separate
     * decisions and the tool should not fuse them.
     */
    if (flag("declared")) {
      const { probeOrder, orderVerdict, verdictFor, gateCells } = await import("../packages/kernel/src/index.mjs")
      const { readFile, writeFile, mkdir } = await import("node:fs/promises")
      const declared = JSON.parse(await readFile(val("declared", ""), "utf8"))
      const base = val("base", "")
      const artifactId = val("artifact", "")
      if (!base || !artifactId) { bad("no-config mode needs --base and --artifact"); process.exit(2) }
      const out = join(ROOT, ".vibeubi"); await mkdir(out, { recursive: true })
      const orderPath = val("order-file", join(out, "probe-order.json"))
      const resultPath = val("result-file", join(out, "probe-result.json"))
      say(`\n${C.bold}vibeubi probe${C.off} ${C.dim}no config · ${declared.length} declared${C.off}\n`)
      if (!flag("judge")) {
        const order = probeOrder({ discovered: [], declared, artifactId, base, skill: val("skill", "dom-test"), only: val("only", "P0").split(",") })
        await writeFile(orderPath, JSON.stringify(order, null, 2), "utf8")
        ok(`${order.items.length} item(s) for ${order.skill}`)
        for (const i of order.items) say(`  ${C.dim}${i.priority}${C.off}  ${i.url}${i.discovered ? "" : C.dim + "  (declared, not discovered)" + C.off}`)
        note(`order  ${relativeish(orderPath)}`)
        return
      }
      const order = JSON.parse(await readFile(orderPath, "utf8"))
      const result = await readFile(resultPath, "utf8").then(JSON.parse).catch(() => null)
      const liveness = await fetch(order.base, { redirect: "manual" })
        .then((r) => ({ ok: r.status < 500, status: r.status }))
        .catch((e) => ({ ok: false, unreachable: e.cause?.code ?? e.message }))
      const judged = orderVerdict({ order, result, liveness })
      const verdict = verdictFor(gateCells({ cells: judged.cells, degraded: [] }))
      say(`  ${judged.verified}/${judged.ordered} verified${judged.unverified ? `, ${judged.unverified} unverified` : ""}\n`)
      for (const c of judged.cells) {
        const mark = c.status === "pass" ? C.green + "✓" : c.status === "blocked" ? C.yellow + "?" : C.red + "✗"
        say(`  ${mark}${C.off} ${C.dim}${c.priority}${C.off} ${c.feature}`)
        if (c.status !== "pass") say(`      ${C.dim}${c.reason}${C.off}`)
      }
      say(`\n  ${verdict.ship ? C.green + "would ship" : C.red + "would ROLL BACK"}${C.off} — ${verdict.reason}`)
      process.exit(verdict.ship ? 0 : 1)
    }

    const { config, ctx } = await boot()
    const { probeOrder, orderVerdict, verdictFor, gateCells } = await import("../packages/kernel/src/index.mjs")
    const { readFile, writeFile, mkdir } = await import("node:fs/promises")
    const cfg = config.probe ?? {}
    const out = join(ROOT, ".vibeubi"); await mkdir(out, { recursive: true })
    const orderPath = val("order-file", join(out, "probe-order.json"))
    const resultPath = val("result-file", join(out, "probe-result.json"))

    say(`\n${C.bold}vibeubi probe${C.off} ${C.dim}${ROOT}${C.off}\n`)

    if (!flag("judge")) {
      const discovered = await discoverAll(ctx)
      const artifactId = val("artifact", "") ||
        (await (ctx.__registry.target?.previousArtifactId?.({ base: config.base }) ?? null)) || ""
      if (!artifactId) {
        // Refused rather than defaulted: an order with no artifact produces a
        // result that cannot be tied to a deploy, and that result would then be
        // accepted by a later ship it knows nothing about.
        bad("no artifact id — pass --artifact <id>, or point base at a running service that echoes one")
        process.exit(2)
      }
      const order = probeOrder({
        discovered, declared: config.declared ?? [], artifactId,
        base: config.base, skill: cfg.skill ?? "dom-test", only: (val("only", "") || (cfg.only ?? ["P0"]).join(",")).split(","),
      })
      await writeFile(orderPath, JSON.stringify(order, null, 2), "utf8")
      ok(`${order.items.length} item(s) for ${C.bold}${order.skill}${C.off} · artifact ${artifactId}`)
      for (const i of order.items) say(`  ${C.dim}${i.priority}${C.off}  ${i.id}${i.testId ? C.dim + "  [" + i.testId + "]" + C.off : ""}`)
      note(`order  ${relativeish(orderPath)}`)
      note(`write the result to ${relativeish(resultPath)}, then: vibeubi probe --judge`)
      return
    }

    const order = JSON.parse(await readFile(orderPath, "utf8"))
    const result = await readFile(resultPath, "utf8").then(JSON.parse).catch(() => null)
    const liveness = await fetch(order.base, { redirect: "manual" })
      .then((r) => ({ ok: r.status < 500, status: r.status }))
      .catch((e) => ({ ok: false, unreachable: e.cause?.code ?? e.message }))
    if (!liveness.ok) bad(`base is not serving: ${liveness.unreachable ?? `HTTP ${liveness.status}`}`)
    const judged = orderVerdict({ order, result, liveness, noiseIsFailure: cfg.noiseIsFailure ?? false })
    const verdict = verdictFor(gateCells({ cells: judged.cells, degraded: [] }))

    say(`  ${judged.covered}/${judged.ordered} ordered item(s) reported on\n`)
    for (const c of judged.cells) {
      const mark = c.status === "pass" ? C.green + "✓" : C.red + "✗"
      say(`  ${mark}${C.off} ${C.dim}${c.priority}${C.off} ${c.feature}${c.volunteered ? C.dim + " (volunteered)" + C.off : ""}`)
      if (c.status !== "pass") say(`      ${C.dim}${c.reason}${C.off}`)
    }
    say(`\n  ${verdict.ship ? C.green + "would ship" : C.red + "would ROLL BACK"}${C.off} — ${verdict.reason}`)
    process.exit(verdict.ship ? 0 : 1)
  },

  async adopt() {
    const { config, ctx } = await boot()
    const { adopt, writeDeclared } = await import("../packages/registry/src/adopt.mjs")
    const { orphanVerdict, requiresHuman } = await import("../packages/kernel/src/index.mjs")

    const discovered = await discoverAll(ctx)
    const v = orphanVerdict(discovered, config.declared ?? [], config.ignored ?? [])
    say(`\n${C.bold}ubi adopt${C.off} ${C.dim}${ROOT}${C.off}\n`)

    if (v.orphans.length === 0) { ok("nothing to adopt — everything discovered is claimed"); return }

    const only = val("only", "")
    const wanted = only.startsWith("area=")
      ? v.orphans.filter((o) => o.id.includes(only.slice(5)))
      : v.orphans

    const r = adopt({ orphans: wanted, prefix: config.testIdPrefix ?? "app", intents: config.intents ?? {} })

    ok(`${r.summary.adopted} orphan(s) claimed`)
    note(`priority  ${Object.entries(r.summary.byPriority).map(([k, n]) => `${k}:${n}`).join("  ")}`)
    note(`areas     ${Object.keys(r.summary.byArea).length}`)

    if (r.proposals.length) {
      say(`\n${C.bold}${C.yellow}needs a human — ${r.proposals.length} proposal(s)${C.off}`)
      say(`${C.dim}These NARROW what gets checked or need a code change. adopt refuses to do either.${C.off}`)
      const gates = r.proposals.filter((p) => p.kind === "gate")
      const pub = r.proposals.filter((p) => p.kind === "publicApi")
      if (gates.length) {
        say(`\n  ${C.red}${gates.length} route(s) that WRITE with no auth check${C.off}`)
        for (const g of gates.slice(0, 6)) say(`     ${g.id}  ${C.dim}${g.suggestion}${C.off}`)
        if (gates.length > 6) note(`…and ${gates.length - 6} more`)
        say(`  ${C.dim}Adopting these did not gate them. Only wiring your guard does.${C.off}`)
      }
      if (pub.length) {
        say(`\n  ${C.yellow}${pub.length} route(s) that MIGHT be deliberately public${C.off}`)
        for (const p of pub.slice(0, 6)) say(`     ${p.id}`)
        say(`  ${C.dim}\`ubi public <id> --reason "…"\` — and ${requiresHuman("public") ? "that one is yours to approve, not mine" : ""}${C.off}`)
      }
    }

    const target = val("config", "") ? resolve(val("config", "")) : join(ROOT, "vibeubi.config.mjs")
    if (flag("dry-run")) { say(`\n${C.dim}--dry-run: nothing written. Target would be ${target}${C.off}\n`); return }

    const before = await readFile(target, "utf8")
    const merged = [...(config.declared ?? []), ...r.declared]
    await writeFile(target, writeDeclared(before, merged), "utf8")
    say("")
    ok(`wrote ${merged.length} declaration(s) into ${relativeish(target)}`)

    const review = join(ROOT, ".vibeubi", "adopt-proposals.json")
    await mkdir(join(ROOT, ".vibeubi"), { recursive: true })
    await writeFile(review, JSON.stringify(r.proposals, null, 2))
    if (r.proposals.length) note(`proposals for a human: ${relativeish(review)}`)
    say(`\n${C.dim}next:  ubi orphans   →  should now be clean${C.off}\n`)
  },

  async ship() {
    const { config, ctx } = await boot()
    const { ship, SHIP_STEPS } = await import("../packages/ship/src/run.mjs")
    const target = ctx.__registry.target
    if (!target) { bad("no deploy target registered — no adapter claimed one"); process.exit(2) }

    const discovered = await discoverAll(ctx)
    const base = val("base", config.base ?? "")
    say(`\n${C.bold}ubi ship${C.off} ${C.dim}${ROOT}${base ? " → " + base : ""}${C.off}\n`)

    const shipCfg = {
      ...config, base,
      verify: config.verify ?? [],
      layers: config.layers ?? ["S0", "S2", "S4"],
      /** The sweep, as an async generator so the gate can judge each cell the
       *  moment it is known rather than at the end. */
      async *sweep({ root, base, discovered }) {
        const { runScan } = await import("../packages/security/src/run.mjs")
        const r = await runScan({ root, config, layers: config.layers ?? ["S0", "S2", "S4"], base, discovered, note: () => {} })

        /**
         * The DECLARED priority wins over the one derived from severity.
         *
         * Getting this backwards is how a ship went green over 61 routes with
         * no auth: every `S2.route.ungated` is severity `high`, high mapped to
         * P1, and P1 does not block. Meanwhile `adopt` had already declared 34
         * of those same routes P0 — and the gate never read the field.
         *
         * "Declared but never read" is the defect class this whole project is
         * about, and it was sitting in the gate's own cell builder.
         */
        const declaredPriority = new Map((config.declared ?? []).map((d) => [d.id, d.priority]).filter(([, p]) => p))
        const fromSeverity = (sev) => (sev === "critical" ? "P0" : sev === "high" ? "P1" : "P2")

        for (const f of r.findings) {
          const declared = declaredPriority.get(f.where)
          yield {
            feature: f.where, layer: f.rule.split(".")[0], reason: f.title,
            priority: declared ?? fromSeverity(f.severity),
            priorityFrom: declared ? "declared" : "severity",
            status: config.baseline?.some((b) => b.fingerprint === f.fingerprint) ? "pass" : "fail",
          }
        }
      },
    }

    const COL = { head: C.bold, ok: C.green, bad: C.red, warn: C.yellow, dim: C.dim }
    let n = 0
    const res = await ship({
      root: ROOT, config: shipCfg, target, discovered,
      emit: (e) => {
        if (e.kind === "step") {
          const s = SHIP_STEPS[e.n]
          if (e.state === "run") return
          const mark = e.state === "pass" ? `${C.green}✓${C.off}` : e.state === "fail" ? `${C.red}✗${C.off}` : `${C.dim}·${C.off}`
          if (e.state === "unreached") say(`  ${C.dim}${mark} ${s.id} — NOT REACHED${C.off}`)
        } else if (e.kind === "cell") { n++ }
        else if (e.kind === "done") {
          say(`\n  ${e.outcome === "shipped" ? C.green : C.red}${e.outcome.toUpperCase()}${C.off}  ${C.dim}${e.reason}${C.off}`)
          note(`${n} cell(s) judged · ${(e.ms / 1000).toFixed(1)}s · ${relativeish(e.outDir)}`)
        } else if (e.msg) {
          say(`  ${COL[e.kind] ?? ""}${e.kind === "head" ? "" : e.kind === "ok" ? "✓ " : e.kind === "bad" ? "✗ " : "· "}${e.msg}${C.off}`)
        }
      },
    })
    process.exit(res.outcome === "shipped" ? 0 : 1)
  },

  async rollback() {
    const { ctx, config } = await boot()
    const target = ctx.__registry.target
    if (!target?.rollback) { bad("this adapter cannot roll back"); process.exit(2) }
    say(`\n${C.bold}ubi rollback${C.off}\n`)
    const before = await target.artifactId?.().catch(() => null)
    await target.rollback()
    await target.restart?.()
    const after = await target.artifactId?.().catch(() => null)
    const { deployProof } = await import("../packages/kernel/src/index.mjs")
    const observed = await target.proof({ base: val("base", config.base ?? ""), expected: after, previous: before })
    const p = deployProof(observed)
    p.ok ? ok(`the running service serves ${after} again — rollback PROVED`) : bad(`ROLLBACK UNPROVEN: ${p.reason}`)
    process.exit(p.ok ? 0 : 1)
  },

  async init() {
    const { probe, renderConfig } = await import("../packages/registry/src/probe.mjs")
    say(`\n${C.bold}ubi init${C.off} ${C.dim}${ROOT}${C.off}\n`)

    const p = await probe(ROOT)
    const f = p.found, g = p.guessed

    say(`${C.bold}found${C.off}`)
    for (const [k, v] of [["framework", f.framework], ["entry", f.entry], ["port", f.port],
                          ["build", f.buildCommand], ["tests", f.testCommand], ["deploy", f.deploy]]) {
      if (v) ok(`${k.padEnd(10)} ${v}`)
    }
    if (!f.framework) bad("no framework recognised — you will need a discoverer, see docs/PLUGINS.md")

    const guessedEntries = Object.entries(g).filter(([, v]) => v)
    if (guessedEntries.length) {
      say(`\n${C.bold}guessed${C.off} ${C.dim}(safe to be wrong — \`ubi orphans\` shows it immediately)${C.off}`)
      for (const [k, v] of guessedEntries) note(`${k.padEnd(10)} ${v}`)
    }

    say(`\n${C.bold}auth helpers in your source${C.off}`)
    if (f.gateTokens.length === 0) {
      bad("none found — until you name yours, EVERY route will read as ungated")
    } else {
      for (const t of f.gateTokens.slice(0, 8)) {
        // A helper defined once and called nowhere is the most interesting
        // thing this probe can find, so it is not buried in a count.
        if (t.declared && t.uses === 0) {
          say(`  ${C.red}!${C.off} ${t.name} ${C.dim}— declared here and called by NOTHING. A control that was built and never wired.${C.off}`)
        } else if (t.uses === 0) {
          note(`${t.name} ${C.dim}— mentioned, never called${C.off}`)
        } else ok(`${t.name} ${C.dim}×${t.uses} call site(s)${C.off}`)
      }
    }

    say(`\n${C.bold}proof${C.off} ${C.red}${p.proof.status}${C.off}`)
    note(p.proof.why)
    note("init does not invent this field — it is the only one where a wrong answer produces no error anywhere else.")

    for (const n of p.notes) note(n)

    if (flag("dry-run")) { say(`\n${C.dim}--dry-run: nothing written.${C.off}\n`); return }

    const out = join(ROOT, "vibeubi.config.mjs")
    if (existsSync(out) && !flag("force")) {
      bad(`vibeubi.config.mjs already exists (use --force, or --dry-run to just look)`)
      process.exit(2)
    }
    const adapterPath = val("adapter", f.framework === "express"
      ? "vibeubi/adapters/express.plugin.mjs"
      : "vibeubi/adapters/nextjs.plugin.mjs")
    await writeFile(out, renderConfig(p, { adapterPath }), "utf8")
    say("")
    ok(`wrote ${relativeish(out)}`)
    say(`\n${C.dim}next:  ubi orphans   →  everything discovered that nobody has claimed`)
    say(`       ubi scan      →  S0–S4 against what you just wired${C.off}\n`)
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

  ${C.bold}roster${C.off}    check the agent/MCP tool surface
  ${C.bold}viz${C.off}       export a diagram IR   --format ir|archify|mermaid
  ${C.bold}scan${C.off}      S0–S4 security layers  --layer S0,S1,S2,S4 [--base URL]
  ${C.bold}adopt${C.off}     claim every orphan  [--dry-run] [--only area=x]
  ${C.bold}ship${C.off}      verify → build → swap → prove → sweep → gate → report
  ${C.bold}probe${C.off}     order the skill step, or judge what it returned  [--judge] [--artifact ID]
            no config needed: --declared <file> --base <url> --artifact <id>
  ${C.bold}rollback${C.off}  put the previous build back, and prove it
  ${C.bold}init${C.off}      probe the project and write a config  [--dry-run] [--force]
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
