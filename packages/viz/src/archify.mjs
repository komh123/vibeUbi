/**
 * archify.mjs — turn a VibeUbi run into a diagram IR.
 *
 * WHY THIS IS DIFFERENT FROM EVERY OTHER "AI ARCHITECTURE DIAGRAM":
 *
 * Diagram skills normally ask an agent to READ a codebase and emit an IR. The
 * agent guesses, and the picture is as right as the guess. Here the registry
 * IS the IR — it was discovered mechanically and declared explicitly, and
 * every edge already carries a verdict from a run. The diagram is therefore
 * VERIFIABLE: each node can be traced to the file it was discovered in and the
 * cell that judged it.
 *
 * Emits a neutral shape plus adapters, so it works with archify or with any
 * other diagram tool (mermaid ships here for zero-dependency fallback).
 */

const STATUS_TONE = { pass: "ok", fail: "danger", error: "danger", blocked: "warn", skip: "muted" }

/**
 * @param {{features:readonly object[], cells:readonly object[], layers:readonly string[], exposure?:readonly object[]}} run
 */
export function toIR(run) {
  const byFeature = new Map()
  for (const c of run.cells ?? []) {
    const list = byFeature.get(c.feature) ?? []
    list.push(c)
    byFeature.set(c.feature, list)
  }

  const worst = (cells) => {
    if (cells.some((c) => c.status === "error")) return "error"
    if (cells.some((c) => c.status === "fail")) return "fail"
    if (cells.some((c) => c.status === "blocked")) return "blocked"
    if (cells.length === 0 || cells.every((c) => c.status === "skip")) return "skip"
    return "pass"
  }

  const areas = new Map()
  for (const f of run.features ?? []) {
    const a = f.area ?? "unclaimed"
    const list = areas.get(a) ?? []
    list.push(f)
    areas.set(a, list)
  }

  return {
    kind: "vibeubi.coverage",
    version: 1,
    title: run.title ?? "Coverage",
    legend: [
      { tone: "ok", label: "checked and passing" },
      { tone: "danger", label: "failing or unanswered" },
      { tone: "warn", label: "blocked by a dependency" },
      { tone: "muted", label: "never checked at this layer" },
    ],
    groups: [...areas.entries()].map(([area, features]) => ({
      id: `area:${area}`,
      label: area,
      nodes: features.map((f) => {
        const cells = byFeature.get(f.id) ?? []
        const status = worst(cells)
        return {
          id: f.id,
          label: f.id.replace(/^[a-z]+:/, ""),
          kind: f.kind,
          priority: f.priority ?? "P2",
          tone: STATUS_TONE[status] ?? "muted",
          // Provenance is the point: every node says where it came from and
          // which cells judged it, so the picture can be checked, not trusted.
          provenance: { discoveredIn: f.source ?? null, declaredIn: f.declaredIn ?? null },
          coverage: (run.layers ?? []).map((l) => ({
            layer: l,
            status: (cells.find((c) => c.layer === l) ?? {}).status ?? "none",
            reason: (cells.find((c) => c.layer === l) ?? {}).reason ?? null,
          })),
        }
      }),
    })),
    edges: (run.exposure ?? []).map((e) => ({
      from: e.reachableFrom ?? "internet",
      to: `${e.service}:${e.port}`,
      label: e.authRequired ? "auth" : "NO AUTH",
      tone: e.authRequired ? "ok" : "danger",
    })),
  }
}

/** Zero-dependency fallback so a diagram exists even with no diagram tool installed. */
export function toMermaid(ir) {
  const lines = ["graph LR"]
  for (const g of ir.groups) {
    lines.push(`  subgraph ${JSON.stringify(g.label)}`)
    for (const n of g.nodes) {
      const shape = n.tone === "danger" ? `["${n.label}"]` : n.tone === "muted" ? `(["${n.label}"])` : `("${n.label}")`
      lines.push(`    ${slug(n.id)}${shape}`)
    }
    lines.push("  end")
  }
  for (const e of ir.edges) lines.push(`  ${slug(e.from)} -->|${e.label}| ${slug(e.to)}`)
  for (const g of ir.groups) for (const n of g.nodes) {
    if (n.tone === "danger") lines.push(`  style ${slug(n.id)} stroke:#A6322A,stroke-width:2px`)
    if (n.tone === "muted") lines.push(`  style ${slug(n.id)} stroke-dasharray: 4 3`)
  }
  return lines.join("\n")
}

const slug = (s) => String(s).replace(/[^a-zA-Z0-9]/g, "_")

/** Archify consumes typed JSON IR; this is the projection onto its schema. */
export function toArchify(ir) {
  return {
    type: "architecture",
    title: ir.title,
    theme: { mode: "auto" },
    legend: ir.legend,
    groups: ir.groups.map((g) => ({
      id: g.id, label: g.label,
      nodes: g.nodes.map((n) => ({
        id: n.id, label: n.label, tag: n.kind, badge: n.priority,
        state: n.tone,
        meta: { provenance: n.provenance, coverage: n.coverage },
      })),
    })),
    edges: ir.edges,
  }
}
