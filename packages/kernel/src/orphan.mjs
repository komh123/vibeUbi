/**
 * orphan.mjs — existence is discovered, meaning is declared.
 *
 * The one rule the whole product is built on:
 *
 *     DISCOVERED BUT NOT DECLARED  =  ORPHAN  =  RED
 *     DECLARED BUT NOT DISCOVERED  =  STALE   =  RED
 *
 * Both directions matter. Orphans are how a new feature ships untested.
 * Stale entries are how a public route survives a rename — the declaration
 * still says "this one is deliberately public" long after the file moved.
 */

/**
 * @param {readonly {id:string, kind:string, source?:string}[]} discovered
 * @param {readonly {id:string}[]} declared
 * @param {readonly {id:string, reason:string}[]} ignored
 */
export function orphanVerdict(discovered, declared, ignored = []) {
  const declaredIds = new Set(declared.map((d) => d.id))
  const ignoredById = new Map(ignored.map((i) => [i.id, i.reason]))
  const discoveredIds = new Set(discovered.map((d) => d.id))

  const orphans = discovered.filter((d) => !declaredIds.has(d.id) && !ignoredById.has(d.id))
  const stale = declared.filter((d) => !discoveredIds.has(d.id))
  const staleIgnores = ignored.filter((i) => !discoveredIds.has(i.id))

  // An exemption without a reason is an exemption that will be inexplicable in
  // six months — and, once AI can write these files, it is the cheapest way
  // for an agent to make a red light go away.
  const unreasoned = ignored.filter((i) => !String(i.reason ?? "").trim())

  const ok = orphans.length === 0 && stale.length === 0 && unreasoned.length === 0
  return {
    ok,
    orphans,
    stale,
    staleIgnores,
    unreasoned,
    reason: ok
      ? `${discovered.length} discovered, all claimed`
      : [
          orphans.length ? `${orphans.length} orphan(s): ${orphans.slice(0, 5).map((o) => o.id).join(", ")}${orphans.length > 5 ? "…" : ""}` : "",
          stale.length ? `${stale.length} stale declaration(s): ${stale.slice(0, 5).map((s) => s.id).join(", ")}` : "",
          unreasoned.length ? `${unreasoned.length} exemption(s) with no reason` : "",
        ].filter(Boolean).join(" · "),
  }
}

/**
 * Which actions narrow what gets checked?
 *
 * This is the single most important list in an AI-driven gate. An agent that
 * can write declarations can also make a red light disappear by writing an
 * exemption instead — and both edits look like "fixing the build".
 *
 * So: widening the check is automatic, narrowing it needs a human.
 */
export const NARROWING_ACTIONS = Object.freeze([
  "ignore",            // exempt a discovered thing from the registry
  "public",            // declare an endpoint deliberately unauthenticated
  "without",           // skip a whole layer for this run
  "accept-debt",       // absorb a security finding into the baseline
  "unpin",             // drop a tool-definition pin
  "lower-priority",    // P0 → P1 is a gate change wearing a metadata costume
  "coverage-ack",      // acknowledge a coverage gap: the red light goes away and no test was written
])

/** @param {string} action */
export function requiresHuman(action) {
  return NARROWING_ACTIONS.includes(action)
}
