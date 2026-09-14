/**
 * adopt.mjs — turn orphans into declarations.
 *
 * THE SPLIT THIS FILE EXISTS TO ENFORCE.
 *
 * Adopting WIDENS what gets checked: it gives every discovered thing an owner,
 * an area, a priority. An agent may do that unsupervised, because the worst
 * case is a wrong priority, which is visible and fixable.
 *
 * It must NEVER narrow. Two temptations sit right next to this code and both
 * make a red light vanish without fixing anything:
 *
 *   · putting a route in `publicApi` — that says "unauthenticated is correct here"
 *   · putting a feature in `ignored`  — that says "this is not a feature"
 *
 * So `adopt` writes `declared` and nothing else. Anything narrowing comes out
 * as a PROPOSAL in a separate review file, for a person to accept or reject.
 *
 * Honest about what this does and does not fix: adopting clears ORPHANS. It
 * does not gate a route. A route with no auth check is still a route with no
 * auth check after every orphan is claimed — that number only moves when
 * somebody wires the guard.
 */

/** Destructive or money-shaped paths are P0 whatever else they look like. */
const P0 = /\b(kill|delete|remove|destroy|drop|purge|cleanup|reset|restart|shutdown|auth|login|logout|session|token|password|billing|payment|charge|refund|admin|oom)\b/i
const P1 = /\b(create|update|write|save|upload|config|settings|user|org|group|member|invite|deploy|recover)\b/i

/** Read-only, no parameters, no obvious data: safe to be P2. */
const P2 = /\b(status|health|version|ping|metrics|logs|docs|stats|list)\b/i

export function areaOf(id) {
  const api = /^api:\/api\/([^/]+)/.exec(id)
  if (api) return api[1]
  if (id.startsWith("page:")) return "client"
  if (id.startsWith("tool:")) return "agent"
  return "other"
}

export function priorityOf(entry) {
  const s = `${entry.id} ${(entry.methods ?? []).join(" ")}`
  const writes = (entry.methods ?? []).some((m) => ["POST", "PUT", "PATCH", "DELETE"].includes(m))
  if (P0.test(s)) return "P0"
  if (writes) return "P0"           // any create/destroy path is P0 by default
  if (P1.test(s)) return "P1"
  if (P2.test(s)) return "P2"
  return "P1"
}

/** A testId a human can actually find in the source, in one shape. */
export function testIdOf(entry, prefix) {
  const tail = entry.id.replace(/^[a-z]+:/, "").replace(/^\/(api\/)?/, "").replace(/[^\w/-]/g, "").replace(/\//g, "-") || "root"
  return `${prefix}-${entry.kind}-${tail}`.toLowerCase().slice(0, 60)
}

/**
 * @param {{orphans:readonly object[], prefix?:string, intents?:Record<string,string>}} input
 * @returns {{declared:object[], proposals:object[], summary:object}}
 */
export function adopt({ orphans, prefix = "app", intents = {} }) {
  const declared = [], proposals = []

  for (const o of orphans) {
    const area = areaOf(o.id)
    const priority = priorityOf(o)
    const intent = intents[o.id] ?? ""

    const entry = {
      id: o.id,
      area,
      kind: o.kind,
      priority,
      requiredRole: guessRole(o, area),
      testId: o.kind === "page" ? testIdOf(o, prefix) : undefined,
      source: o.source,
      ...(intent ? { intent } : {}),
    }
    // probes are required for P0 pages; derive what we can from the intent.
    if (priority === "P0" && o.kind === "page") entry.probes = probesFrom(intent, entry.testId)
    declared.push(clean(entry))

    // Narrowing suggestions leave through a different door.
    if (o.kind === "api" && P2.test(o.id) && !/\b(admin|config|logs)\b/i.test(o.id)) {
      proposals.push({
        kind: "publicApi", id: o.id,
        suggestion: "looks read-only and non-sensitive — but this is YOUR call",
        needs: "a written reason, and confirmation that it exposes nothing about other users",
      })
    }
    if (o.kind === "api" && (o.methods ?? []).some((m) => m !== "GET")) {
      proposals.push({
        kind: "gate", id: o.id,
        suggestion: `${(o.methods ?? []).filter((m) => m !== "GET").join("/")} with no auth check — wire your guard onto this handler`,
        needs: "a code change, not a declaration. Adopting it does not gate it.",
      })
    }
  }

  return {
    declared,
    proposals,
    summary: {
      adopted: declared.length,
      byPriority: count(declared.map((d) => d.priority)),
      byArea: count(declared.map((d) => d.area)),
      needsHuman: proposals.length,
    },
  }
}

function guessRole(o, area) {
  if (/\b(admin|host-protection|oom|processes|disk)\b/i.test(o.id)) return "admin"
  if (/\b(auth|login|signup|version|health|docs)\b/i.test(o.id)) return "guest"
  return "user"
}

/**
 * Probes from free text.
 *
 * Deliberately shallow: it recognises the ONE distinction that is a real
 * safety property and easy to get wrong, and otherwise emits a visibility
 * check plus a TODO a human will see.
 *
 * `expectHidden` and `expectDisabled` are not interchangeable: a destructive
 * control that is present and REFUSING is a different property from one that
 * is absent, and `expectVisible` is blind to the difference.
 */
export function probesFrom(intent, testId) {
  const p = [{ expectVisible: testId }]
  if (/\b(disabled|停用|不能按|refus|cannot submit)\b/i.test(intent)) p.push({ expectDisabled: testId })
  else if (/\b(hidden|消失|不顯示|not shown)\b/i.test(intent)) p.push({ expectHidden: testId })
  if (/\b(unchanged|不變|must not change)\b/i.test(intent)) p.push({ invariant: { computedStyle: testId } })
  if (!intent) p.push({ __todo: "no intent given — `ubi intent <id> \"…\"` and re-run adopt to derive real probes" })
  return p
}

const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined))
const count = (xs) => xs.reduce((m, x) => ({ ...m, [x]: (m[x] ?? 0) + 1 }), {})

/** Render the declarations back into a config file, replacing `declared: [...]`. */
/**
 * Replace the `declared: [ … ]` block in a config file.
 *
 * Handles the empty one-line form too. The first version only matched a block
 * that spanned lines, so a freshly-written `declared: [],` — which is exactly
 * what `ubi init` produces — silently failed to match and adopt wrote nothing
 * while reporting 74 claims. A writer that cannot write into the file its own
 * init created is a writer nobody can use once.
 */
export function writeDeclared(configText, declared) {
  const body = declared.map((d) => "    " + JSON.stringify(d)).join(",\n")
  const re = /(\bdeclared:\s*)\[[\s\S]*?\](\s*,?)/
  if (!re.test(configText)) throw new Error("could not find a `declared: [...]` block to write into")
  return configText.replace(re, `$1[\n${body}\n  ]$2`)
}
