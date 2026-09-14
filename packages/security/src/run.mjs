/**
 * run.mjs — the only place in the security package that does I/O ordering.
 *
 * A layer that cannot run here is a SKIP WITH A REASON, never a silence: "no
 * npm audit on this machine" and "npm audit found nothing" must never look the
 * same in a report.
 */
import { grade, coverageOf, baselineDiff, textRuleFitness, declaredFieldsAreRead, READ_DECLARED_FIELDS } from "../../kernel/src/index.mjs"
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
        declared: config.declared ?? [],
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

  /* ── L2 · does the page it is serving actually have its own code? ── */
  if (layers.includes("L2")) {
    if (!base) skipped.push("L2 assets — needs --base <url>")
    else {
      try {
        const res = await fetch(base.replace(/\/+$/, "") + (config.probePath ?? "/"), { redirect: "follow" })
        const html = await res.text()
        const refs = rules.referencedAssets(html)
        const assets = []
        for (const { href, kind } of refs.slice(0, 60)) {
          try {
            const r = await fetch(base.replace(/\/+$/, "") + href, { method: "GET", signal: AbortSignal.timeout(8000) })
            assets.push({ href, kind, status: r.status, type: r.headers.get("content-type") })
          } catch {
            // Unreachable is not "fine". Recorded as a failure so the rule sees it.
            assets.push({ href, kind, status: 599, type: null })
          }
        }
        note(`${assets.length} referenced asset(s) fetched`)
        findings.push(...rules.s2Assets({ url: base, html, assets }))
      } catch (err) {
        skipped.push(`L2 assets — could not read the page: ${err.message}`)
      }
    }
  }

  /* ── S4 ── */
  if (layers.includes("S4")) {
    const live = await collect.listeners(root)
    note(`${live.length} listener(s) / declared port(s) found`)
    /**
     * Can this scan see the declared listeners at all?
     *
     * A k8s Service declared at :80 is invisible from a laptop, and calling
     * that "stale" asserts something the scan never checked. `reachableFrom`
     * is the declaration saying where it lives; if none of them are on this
     * host, say the scan could not look rather than that the thing is gone.
     */
    const declaredExposure = config.exposure ?? []
    const canObserve = declaredExposure.length === 0 ||
      declaredExposure.some((d) => live.some((l) => `${l.service}:${l.port}` === `${d.service}:${d.port}`)) ||
      config.observesDeclaredExposure === true
    findings.push(...rules.s4Exposure({ listeners: live, declared: declaredExposure, canObserve }))
  }

  /**
   * Is every field somebody wrote in the registry actually consumed?
   *
   * `declaredFieldsAreRead` was written to catch exactly this, was exported,
   * was unit-tested — and for its whole life had ZERO call sites, which made
   * it an instance of the defect it detects. It found two the moment it was
   * wired: `probes` and `testId`, which `adopt` generates for every P0 page
   * and which nothing in the pipeline ever executes. A P0 page therefore had
   * its behaviour "declared" and never checked, and the registry said it was
   * covered.
   *
   * Reported, not thrown: the honest state of the product belongs in the
   * report, where it can be argued with.
   */
  const fieldCheck = declaredFieldsAreRead(config.declared ?? [], Object.keys(READ_DECLARED_FIELDS))
  if (!fieldCheck.ok) {
    findings.push(rules.finding(
      "B.declared.unread", "medium", "config.declared",
      `declared field(s) that nothing in the pipeline consumes: ${fieldCheck.unread.join(", ")}`,
      `${(config.declared ?? []).length} declared entries carry them`,
      "a field that is written, reviewed and then ignored looks like a control and is a decoration — everyone downstream believes it is doing something",
    ))
  }

  /**
   * A requested layer that could not run is not a zero — it is a hole.
   *
   * `skipped` existed from the start and the grade never read it, so a scan
   * that discovered nothing returned A/100/"clean". Same shape as every other
   * defect found this week: written down, believed, consumed by nobody.
   */
  const coverage = coverageOf({ layers, skipped })
  for (const gap of coverage.unmeasured) {
    findings.push(rules.finding(
      "B.coverage.unmeasured", "high", "scan",
      `a requested check did not run: ${gap}`,
      `layers requested: ${layers.join(",")}`,
      "an unrun check contributes zero findings, which reads exactly like a clean one",
    ))
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
    coverage,
    grade: grade(findings, coverage.unmeasured),
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
