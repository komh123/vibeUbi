/**
 * acceptance.mjs — functional behaviour, judged AFTER the swap.
 *
 * THE DEFECT THIS EXISTS FOR. A project put a functional "acceptance" stage in
 * its chain `verify -> acceptance -> build -> deploy` and pointed it at `base`.
 * Before the swap `base` is production, and production is still the PREVIOUS
 * build — so the stage judged the build being replaced. Old-build flakiness and
 * behaviour that only exists in the new build both blocked the new build, and
 * two deploys were each blocked three times. docs/SKILL-STEP.md had said so
 * ("a strict pre-swap pass judges the build you are replacing") and the
 * framework offered no place to run it correctly and no refusal for running it
 * wrongly. Both are here.
 *
 * TWO PLACES, AND ONLY TWO:
 *
 *   post-swap        after swap + prove + sweep + gate + probe. The only place
 *                    behaviour can be judged, because the new build is the thing
 *                    being served. A P0 red here rolls back — the same rollback,
 *                    proved the same way, as a P0 red in the gate or the probe.
 *   pre-swap-health  before build. Is the world alive enough to try — login
 *                    works, one short request answers, the db / model / sandbox
 *                    respond? It judges the build being REPLACED and the
 *                    dependencies, never the feature, so it must say so
 *                    (`healthOnly: true`), bound its time, and its failure
 *                    refuses the ship while nothing has been touched.
 *
 * NOTHING IN HERE JUDGES. Results are turned into cells by `orderVerdict` — the
 * probe's own judge — and then through `gateCells` / `verdictFor`, so one
 * definition of "P0 red", "error" and "blocked" serves the gate, the probe and
 * this. A second judge is how two layers come to disagree about one result.
 *
 * Zero I/O. Every function here is pure; `ship` does the looking.
 */
import { sameObserved } from "./proof.mjs"
import { orderVerdict } from "./order.mjs"

/** Where acceptance may run. Anything else is not a position in the pipeline. */
export const ACCEPTANCE_PHASES = Object.freeze(["post-swap", "pre-swap-health"])
export const ACCEPTANCE_SEVERITIES = Object.freeze(["P0", "P1", "P2"])
/** What an item may claim to judge. Required before the swap, where the
 *  difference between the two is the whole safety argument. */
export const ACCEPTANCE_JUDGES = Object.freeze(["health", "behaviour"])
/** A health check is "one shortest request", not a test run. Two minutes. */
export const HEALTH_BUDGET_MAX_MS = 120_000
/** Retries exist to separate a flake from a failure before a ROLLBACK; five is
 *  already more than that question needs. */
export const ACCEPTANCE_MAX_ATTEMPTS = 5

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v)
const items = (d) => (Array.isArray(d?.items) ? d.items : [])
const norm = (b) => (typeof b === "string" && b.trim() ? b.trim().replace(/\/+$/, "").toLowerCase() : null)
const stagingBase = (d) => (isObj(d?.staging) && typeof d.staging.base === "string" && d.staging.base.trim() ? d.staging.base : null)

/**
 * Is this declaration capable of meaning what it says?
 *
 * Checked at wiring time like `proofContract`, for the same reason: every field
 * here can be wrong in a way that type-checks and runs and judges nothing. A
 * missing severity is REFUSED rather than defaulted — defaulting to P0 makes a
 * decoration roll back deploys, defaulting to P2 makes a rollback gate that
 * cannot roll back, and neither is what the author decided.
 *
 * @param {object} decl
 * @param {{productionBase?: string|null}} [o]
 * @returns {{ok:true} | {ok:false, reason:string, faults:string[]}}
 */
export function acceptanceContract(decl, { productionBase = null } = {}) {
  if (!isObj(decl)) return refuse(["acceptance must be an object"])
  const faults = []
  const pre = decl.phase === "pre-swap-health"

  if (!ACCEPTANCE_PHASES.includes(decl.phase)) {
    faults.push(
      `phase ${JSON.stringify(decl.phase)} is not a place in the pipeline. The only phases are ` +
      `${ACCEPTANCE_PHASES.map((p) => `"${p}"`).join(" and ")}` +
      (/^(pre|before)/i.test(String(decl.phase ?? "")) ? ` — "pre-swap-health" is the only thing that may run before the swap, and it may only check health` : ""),
    )
  }
  if (typeof decl.fulfil !== "function") {
    faults.push("`fulfil` is missing — nothing would ever produce a result, so every item would read as unreported")
  }

  const list = items(decl)
  if (list.length === 0) faults.push("`items` is empty or missing — an acceptance with no items judges nothing")
  const seen = new Set()
  for (const [i, it] of list.entries()) {
    const id = isObj(it) && typeof it.id === "string" && it.id.trim() ? it.id : null
    const name = id ? `"${id}"` : `item #${i}`
    if (!id) { faults.push(`item #${i} has no id`); continue }
    if (seen.has(id)) faults.push(`item "${id}" is declared twice — a result row could be about either`)
    seen.add(id)
    if (!ACCEPTANCE_SEVERITIES.includes(it.severity)) {
      faults.push(`item ${name} declares no severity (got ${JSON.stringify(it.severity)}; one of ${ACCEPTANCE_SEVERITIES.join("/")}) — refused, not defaulted: whether a red here rolls back is the author's decision`)
    }
    if (it.attempts !== undefined) {
      if (!Number.isInteger(it.attempts) || it.attempts < 1 || it.attempts > ACCEPTANCE_MAX_ATTEMPTS) {
        faults.push(`item ${name}: attempts must be an integer from 1 to ${ACCEPTANCE_MAX_ATTEMPTS}`)
      } else if (it.attempts > 1 && it.severity !== "P0") {
        faults.push(`item ${name}: attempts > 1 only means something for a P0 item — a retry exists to protect a rollback decision, and ${it.severity ?? "this"} has none`)
      }
    }
    if (it.judges !== undefined && !ACCEPTANCE_JUDGES.includes(it.judges)) {
      faults.push(`item ${name}: judges must be "health" or "behaviour", got ${JSON.stringify(it.judges)}`)
    }
    if (pre && it.judges === undefined) {
      faults.push(`item ${name} does not say what it judges — before the swap that is the whole safety question, so it must be explicit (judges: "health")`)
    }
  }

  if (pre) {
    if (typeof decl.healthOnly !== "boolean") {
      faults.push("pre-swap-health must declare `healthOnly: true` — silence is not a declaration, and this phase may not assert feature behaviour")
    }
    const t = decl.timeBudgetMs
    if (typeof t !== "number" || !Number.isFinite(t) || t <= 0 || t > HEALTH_BUDGET_MAX_MS) {
      faults.push(`pre-swap-health must carry a bounded \`timeBudgetMs\` (1..${HEALTH_BUDGET_MAX_MS}), got ${String(t)} — it runs before anything is built, and an unbounded wait there stops every ship`)
    }
  } else if (decl.phase === "post-swap") {
    // Declared but never read. These mean something only before the swap, and
    // a knob that is accepted and ignored looks like a control.
    if (decl.healthOnly !== undefined) faults.push("`healthOnly` only means something for pre-swap-health — post-swap judges behaviour, which is its job")
    if (decl.staging !== undefined) faults.push("`staging` only means something for pre-swap-health — post-swap already judges the production base, after it holds the new build")
    if (decl.timeBudgetMs !== undefined && (!Number.isFinite(decl.timeBudgetMs) || decl.timeBudgetMs <= 0)) {
      faults.push("`timeBudgetMs` must be a positive number")
    }
  }

  if (decl.staging !== undefined) {
    if (!stagingBase(decl)) faults.push("`staging` must be `{ base: <url> }` — an empty one is not a separate instance")
    else if (productionBase != null && sameObserved(norm(stagingBase(decl)), norm(productionBase), { what: "staging" }).same) {
      faults.push(`staging.base is the production base (${productionBase}) — that is not a separate instance, it is the build being replaced under another name`)
    }
  }
  return faults.length === 0 ? { ok: true } : refuse(faults)
}

const refuse = (faults) => ({ ok: false, faults, reason: `acceptance cannot be trusted as declared: ${faults.join("; ")}` })

/**
 * May this declaration run a FUNCTIONAL check before the swap?
 *
 * Default: no — and the reason is SKILL-STEP's, because it is the argument that
 * was already written down and not acted on: before the swap `base` is still
 * serving the PREVIOUS artifact, so a pre-swap pass judges the build you are
 * replacing. Old-build flakiness blocks the new build; behaviour that exists
 * only in the new build fails against the old one. Neither says anything about
 * what you are about to ship.
 *
 * What counts as functional, from the declaration's OWN words rather than from
 * a flag alone: a `pre-…` phase that is not `pre-swap-health`; `healthOnly`
 * anything but true; or ANY item that judges "behaviour". The flag is a claim
 * and the item is the evidence — `healthOnly: true` above a behaviour item is
 * exactly where the naive predicate (`healthOnly === true`, so fine) is wrong.
 *
 * The one exception is a separate staging instance, which is the only thing that
 * CAN hold the new build before the swap. It is allowed and it WARNS, because
 * vibeUbi cannot see which build staging holds — that is the project's
 * promise, and it is said in the report every time rather than assumed.
 * "We do not know whether staging differs from production" is a third answer
 * and does not grant the exception.
 *
 * @param {object} decl
 * @param {{productionBase?: string|null}} [o]
 * @returns {{refuse:boolean, warn:boolean, reason:string, offending:string[]}}
 */
export function preSwapBehaviourVerdict(decl, { productionBase = null } = {}) {
  const phase = String(decl?.phase ?? "")
  const isHealth = phase === "pre-swap-health"
  const isOtherPre = !isHealth && /^(pre|before)/i.test(phase)
  if (!isHealth && !isOtherPre) return { refuse: false, warn: false, reason: "", offending: [] }

  const offending = []
  if (isOtherPre) offending.push(`phase "${phase}"`)
  if (isHealth && decl.healthOnly !== true) offending.push("healthOnly is not true")
  for (const it of items(decl)) if (it?.judges === "behaviour") offending.push(String(it.id))
  if (offending.length === 0) return { refuse: false, warn: false, reason: "", offending: [] }

  const sb = stagingBase(decl)
  const cmp = sameObserved(norm(sb), norm(productionBase), { what: "staging base vs production base" })
  if (sb && cmp.known && !cmp.same) {
    return {
      refuse: false, warn: true, offending,
      reason:
        `functional behaviour is checked BEFORE the swap (${offending.join(", ")}) against the separate staging instance ${sb}. ` +
        `That is allowed because staging is not the production base — but vibeUbi cannot see which build staging holds. ` +
        `If it is not the tree being shipped, this passes for the same reason the pre-swap pass was refused.`,
    }
  }
  return {
    refuse: true, warn: false, offending,
    reason:
      `acceptance judges functional behaviour before the swap (${offending.join(", ")}), and a pre-swap pass judges the build you are replacing: ` +
      `until the swap, base is still serving the PREVIOUS artifact, so old-build flakiness blocks the new build and behaviour that exists only in the new build fails against the old one. ` +
      `Move it to phase "post-swap", or keep pre-swap to liveness (phase "pre-swap-health", healthOnly: true, items that judge "health"), ` +
      `or declare a separate staging instance (staging: { base }) that holds the new build.` +
      (sb && cmp.known && cmp.same ? ` (staging.base is the production base — not a separate instance.)` : sb && !cmp.known ? ` (staging could not be compared with the production base, so it is not treated as separate.)` : ""),
  }
}

/**
 * The order an agent or function fulfils — the probe order's shape, so the
 * same admission and the same judge apply.
 *
 * `priority` IS the declared severity and cannot be overridden by a stray field
 * on the item: the rest of the item (a path, a role, a locator) is the
 * project's own and passes through untouched, because the order is the only
 * thing the fulfiller is told.
 */
export function acceptanceOrder({ acceptance, artifactId, base }) {
  const phase = acceptance.phase
  const sorted = items(acceptance)
    .map((it) => ({ ...it, priority: it.severity }))
    .sort((a, b) => a.priority.localeCompare(b.priority) || a.id.localeCompare(b.id))
  return {
    skill: acceptance.skill ?? "acceptance",
    artifactId, base, at: "acceptance", phase,
    ...(phase === "pre-swap-health"
      ? {
          healthOnly: acceptance.healthOnly === true,
          timeBudgetMs: acceptance.timeBudgetMs,
          limits:
            "this runs BEFORE the swap, against the build being replaced and the dependencies it needs. " +
            "Report whether each is alive; do not assert what any feature does — that is judged after the swap.",
        }
      : {}),
    contract: {
      itemsAreIndependent: true,
      why: "each item gets a FRESH SESSION — its own cookies, storage and auth state. An item that depends on the one before it breaks on an unrelated edit.",
    },
    items: sorted,
  }
}

/**
 * Judge a result — with the probe's own judge.
 *
 * Before the swap (`pre-swap-health`) an unmeasured item REFUSES: "I could not
 * see it" is free there, because nothing has been touched. After it, the same
 * absence must not undo a good deploy — see `orderVerdict` for that argument,
 * which applies here unchanged.
 */
export function acceptanceVerdict({ order, result, liveness = null, phase = order?.phase, noiseIsFailure = true }) {
  return orderVerdict({
    order, result, liveness, noiseIsFailure,
    unmeasuredBlocks: phase === "pre-swap-health",
    layer: "acceptance",
  })
}

/**
 * Which items deserve another attempt?
 *
 * Only an item that FAILED, is P0, and has attempts left. A blocked or errored
 * item is a question about the measurement, and asking again answers "is it
 * flaky?" rather than "did we see it?". And nothing is retried while something
 * other than an item is failing — a base that is down or a result that does not
 * belong to this deploy is not a flake, it is the thing the retry would hide.
 *
 * @returns {string[]} ids
 */
export function retryItems({ order, cells, attemptsDone }) {
  const byId = new Map(order.items.map((i) => [i.id, i]))
  const structural = cells.some((c) => !byId.has(c.feature) && !c.volunteered && (c.status === "fail" || c.status === "error"))
  if (structural) return []
  return cells
    .filter((c) => {
      const it = byId.get(c.feature)
      return it && c.status === "fail" && it.priority === "P0" && (it.attempts ?? 1) > attemptsDone
    })
    .map((c) => c.feature)
}

/**
 * Collapse attempt rounds into the cells the gate will judge — without losing
 * what the retry hid.
 *
 * The latest round wins, because it is the most recent measurement. But a P0
 * that failed and then passed is `flaky`, carried on the cell with the failure
 * it overwrote in its reason, and listed separately for the report. A retry
 * that quietly turns red into green is how a gate gets decorative; this makes
 * the pass cost a visible word.
 *
 * @param {readonly (readonly object[])[]} rounds  cells per round, in order
 * @returns {{cells: object[], flaky: {feature:string, attempts:number, failures:string[]}[]}}
 */
export function foldAttempts(rounds) {
  const history = new Map()
  for (const round of rounds) for (const c of round) {
    if (!history.has(c.feature)) history.set(c.feature, [])
    history.get(c.feature).push(c)
  }
  const cells = []
  const flaky = []
  for (const [feature, h] of history) {
    const last = h.at(-1)
    const failures = h.slice(0, -1).filter((c) => c.status === "fail").map((c) => c.reason)
    if (h.length === 1) { cells.push(last); continue }
    if (last.status === "pass" && failures.length > 0) {
      cells.push({
        ...last, flaky: true, attempts: h.length,
        reason: `FLAKY: passed on attempt ${h.length} after failing ${failures.length} time(s) — ${failures[0]}`,
      })
      flaky.push({ feature, attempts: h.length, failures })
    } else {
      cells.push({ ...last, attempts: h.length })
    }
  }
  return { cells, flaky }
}
