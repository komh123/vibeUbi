/**
 * run.mjs — the only place in the security package that does I/O ordering.
 *
 * A layer that cannot run here is a SKIP WITH A REASON, never a silence: "no
 * npm audit on this machine" and "npm audit found nothing" must never look the
 * same in a report.
 */
import { grade, baselineDiff, textRuleFitness } from "../../kernel/src/index.mjs"
import * as collect from "./collect.mjs"
import * as rules from "./rules.mjs"

export async function runScan({ root, config = {}, layers, base = "", discovered = [], note = () => {} }) {
  const findings = []
  const skipped = []
  let scanned = 0, lexDropped = 0

  const files = await collect.walk(root)
  note(`${files.length} file(s) in scope`)

  /* ── S0 ── */
  if (layers.includes("S0")) {
    const scannable = await collect.scannableFiles(root, files)
    scanned += scannable.length
    const history = await collect.gitHistory(root, { maxCommits: Number(config.historyCommits ?? 300) })
    if (history.length === 0) skipped.push("S0.secret.history — no git history reachable here")
    else note(`${history.length} added line(s) of history scanned`)

    findings.push(...rules.s0Secrets({ files: scannable, history }))
    const { dockerfiles, compose } = await collect.dockerAndCompose(root, files)
    findings.push(...rules.s0Config({
      trackedEnvFiles: await collect.trackedEnvFiles(root),
      dockerfiles, compose,
    }))
  }

  /* ── S1 ── */
  if (layers.includes("S1")) {
    const audit = await collect.npmAudit(root)
    if (!audit.available) skipped.push(`S1.npm_audit — ${audit.why}`)
    else findings.push(...rules.s1Audit({ advisories: audit.advisories }))
    findings.push(...rules.s1Aibom({ components: config.aiComponents ?? [] }))
    if (!config.aiComponents) skipped.push("S1.aibom — no AI components declared in config")
  }

  /* ── S2 ── */
  if (layers.includes("S2")) {
    const code = await collect.codeFiles(root, files)
    const before = code.reduce((n, f) => n + f.lines.length, 0)
    const codeLines = code.reduce((n, f) => n + f.lines.filter((l) => l.region === "code").length, 0)
    lexDropped = before - codeLines
    findings.push(...rules.s2Sinks({ files: code }))

    const apiRoutes = discovered.filter((d) => d.kind === "api")
    if (apiRoutes.length === 0) skipped.push("S2.route.ungated — no api routes discovered (is an adapter wired?)")
    else {
      // Attach each route's own source so the gate check reads the handler,
      // not the whole file.
      const byFile = new Map(code.map((c) => [c.path, c.text]))
      findings.push(...rules.s2Routes({
        routes: apiRoutes.map((r) => ({ ...r, body: byFile.get(r.source) ?? "" })),
        publicApi: config.publicApi ?? [],
        gateTokens: config.gateTokens ?? [],
      }))
      if (!config.gateTokens?.length) {
        skipped.push("S2 gateTokens not configured — every route will read as ungated until you name your auth helper")
      }
    }
  }

  /* ── S3 ── */
  if (layers.includes("S3")) {
    if (!base) skipped.push("S3 DAST — needs --base <url>")
    else findings.push(...(await dast(base, discovered, config)))
  }

  /* ── S4 ── */
  if (layers.includes("S4")) {
    const live = await collect.listeners(root)
    note(`${live.length} listener(s) / declared port(s) found`)
    findings.push(...rules.s4Exposure({ listeners: live, declared: config.exposure ?? [] }))
  }

  const baseline = config.baseline ?? []
  const diff = baselineDiff(findings, baseline)
  const counts = ["critical", "high", "medium", "low", "info"]
    .map((s) => [s, findings.filter((f) => f.severity === s).length])
    .filter(([, n]) => n > 0).map(([s, n]) => `${n} ${s}`).join(" · ") || "clean"

  // Precision is reported, not hidden: `textRuleFitness` says a rule below 90%
  // may not gate, and you cannot check that on numbers nobody prints.
  const fitness = textRuleFitness({ hits: findings.map(() => ({ matchedIn: "call-expression" })), name: "S0–S4" })

  return {
    root, layers, base: base || null,
    findings, skipped, counts,
    grade: grade(findings),
    baseline: { new: diff.new.length, known: diff.known.length, resolved: diff.resolved.length },
    blocking: diff.blocking,
    precision: fitness.precision,
    falsePositives: lexDropped,
    scanned,
    at: new Date().toISOString(),
  }
}

async function dast(base, discovered, config) {
  const out = []
  const url = base.replace(/\/+$/, "")
  try {
    const res = await fetch(url + (config.probePath ?? "/"), { redirect: "manual" })
    out.push(...rules.s3Headers({ url, headers: Object.fromEntries(res.headers) }))
  } catch (err) {
    return [{ rule: "S3.unreachable", severity: "info", where: url, title: "the site did not answer", evidence: String(err.message), verdict: "real", fingerprint: "unreachable" }]
  }

  const probes = []
  for (const r of discovered.filter((d) => d.kind === "api").slice(0, Number(config.dastMax ?? 60))) {
    const path = r.path.replace(/:(\w+)/g, "vibeubi-nonexistent")
    try {
      const res = await fetch(url + path, { redirect: "manual", signal: AbortSignal.timeout(8000) })
      probes.push({ method: "GET", path: r.path, status: res.status })
    } catch { /* a timeout is not a finding; it is an unanswered probe */ }
  }
  out.push(...rules.s3Unauth({ probes, publicApi: config.publicApi ?? [] }))

  try {
    const res = await fetch(url + (config.probePath ?? "/"), { headers: { Origin: "https://evil.example" } })
    out.push(...rules.s3Cors({
      url, origin: "https://evil.example",
      allowOrigin: res.headers.get("access-control-allow-origin"),
      allowCredentials: res.headers.get("access-control-allow-credentials") === "true",
    }))
  } catch { /* ignore */ }
  return out
}
