/**
 * plugin.mjs — the extension contract, shaped like a DSH/cordis plugin.
 *
 * A VibeShip plugin is a plain ESM module:
 *
 *     export const name = "vibeship-nextjs"
 *     export function apply(ctx, config = {}) { ... }
 *
 * Loaded by path. No build step, no framework, no registry to publish to.
 * That shape was chosen because it is the smallest thing that works in every
 * harness: anything that can `import()` a file can host a plugin.
 *
 * THE FAILURE POLICY IS THE POINT. A plugin must never throw into the host
 * loop and never block it. Not configured → return silently. Something broke
 * → that capability is dead for the rest of the run and SAYS SO; the run
 * continues on what still works.
 *
 * Nothing here is a gate decision. Plugins supply capability; the kernel
 * judges. That separation is what lets an AI write plugins freely.
 */

/**
 * @typedef {Object} Ctx
 * @property {(kind:string, fn:Function)=>void} discover  register a discoverer (axiom A)
 * @property {(id:string, layer:object)=>void}  layer     register a check layer
 * @property {(id:string, rule:object)=>void}   rule      register a security rule
 * @property {(target:object)=>void}            target    register build/swap/proof (one per run)
 * @property {(fn:Function)=>void}              session   register sessionFor(role)
 * @property {(event:string, fn:Function)=>void} on       subscribe to run events
 * @property {(msg:string)=>void}               note      say something into the report
 */

export function createContext() {
  const reg = {
    discoverers: new Map(),
    layers: new Map(),
    rules: new Map(),
    target: null,
    session: null,
    listeners: new Map(),
    notes: [],
    disabled: [],
  }

  /** Wrap a plugin-supplied function so a throw kills the capability, not the run. */
  const guard = (owner, what, fn) => async (...args) => {
    try {
      return await fn(...args)
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err)
      reg.disabled.push({ owner, what, why })
      // Deliberately NOT rethrown: the run reports a dead capability, which the
      // kernel turns into an `error` cell. A crashed plugin must not be able to
      // silently remove a check — but it must also not be able to abort a run.
      return { __vibeship_capability_failed: true, owner, what, why }
    }
  }

  const ctx = {
    discover(kind, fn) { reg.discoverers.set(kind, guard(ctx.__owner, `discover:${kind}`, fn)) },
    layer(id, layer) { reg.layers.set(id, { ...layer, run: guard(ctx.__owner, `layer:${id}`, layer.run) }) },
    rule(id, rule) { reg.rules.set(id, { ...rule, run: guard(ctx.__owner, `rule:${id}`, rule.run) }) },
    target(t) {
      if (reg.target) throw new Error(`two plugins claimed the deploy target: ${reg.target.__owner} and ${ctx.__owner}`)
      reg.target = { ...t, __owner: ctx.__owner }
    },
    session(fn) { reg.session = guard(ctx.__owner, "session", fn) },
    on(event, fn) {
      const list = reg.listeners.get(event) ?? []
      list.push(guard(ctx.__owner, `on:${event}`, fn))
      reg.listeners.set(event, list)
    },
    note(msg) { reg.notes.push(`${ctx.__owner}: ${msg}`) },
    __owner: "core",
    __registry: reg,
  }
  return ctx
}

/**
 * @param {Ctx} ctx
 * @param {readonly {name?:string, apply?:Function}[]} plugins
 * @param {Record<string, object>} config keyed by plugin name
 */
export async function applyAll(ctx, plugins, config = {}) {
  const loaded = []
  for (const p of plugins) {
    const name = p?.name
    if (!name || typeof p.apply !== "function") {
      ctx.__registry.disabled.push({ owner: name ?? "<anonymous>", what: "load", why: "a plugin needs `name` and `apply`" })
      continue
    }
    ctx.__owner = name
    try {
      await p.apply(ctx, config[name] ?? {})
      loaded.push(name)
    } catch (err) {
      ctx.__registry.disabled.push({ owner: name, what: "apply", why: err instanceof Error ? err.message : String(err) })
    }
  }
  ctx.__owner = "core"
  return { loaded, disabled: ctx.__registry.disabled }
}

/** Turn dead capabilities into cells the gate will actually see. */
export function capabilityCells(registry) {
  return registry.disabled.map((d) => ({
    status: "error",
    priority: "P0",
    feature: `plugin:${d.owner}`,
    layer: d.what,
    reason: `capability failed and was disabled for this run: ${d.why}`,
  }))
}
