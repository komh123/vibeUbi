# The plugin contract

Modelled on DSH/cordis plugins, because that is the smallest shape that works
in every host: **anything that can `import()` a file can load one.**

```js
export const name = "vibeubi-fastapi"

export function apply(ctx, config = {}) {
  if (!config.root) return          // not configured → silent no-op, never a throw

  ctx.discover("route", async () => [...])   // A · existence
  ctx.layer("L1", { run: async (f) => [...] })
  ctx.rule("S5.egress", { run: async () => [...] })
  ctx.target({ proofClaim, proof, build, swap })  // C · evidence
  ctx.session(async (role) => ({ cookie: "…" }))

  ctx.on("dispose", () => { /* let go of everything */ })
}
```

## The failure policy is the point

A plugin **never throws into the host loop and never blocks it.**

- Not configured → return silently.
- Something broke → that capability is dead for the rest of the run and
  **says so**; the run continues on what still works.

The kernel wraps every plugin-supplied function. A throw is caught, the
capability is disabled, and `capabilityCells()` turns it into an **`error`
cell** — which blocks the gate.

That combination is deliberate:

> A crashed plugin must not be able to abort a run.
> A crashed plugin must not be able to silently remove a check.

The first would make the tool unusable. The second would make it dishonest.

## ctx

| method | purpose | axiom |
|---|---|---|
| `ctx.discover(kind, fn)` | enumerate what exists | A |
| `ctx.layer(id, {run})` | a check layer | — |
| `ctx.rule(id, {run})` | a security rule | — |
| `ctx.target(t)` | build / swap / **proof** — one per run | C |
| `ctx.session(fn)` | mint credentials for a role | — |
| `ctx.on(event, fn)` | run events, plus `dispose` | — |
| `ctx.note(msg)` | say something into the report | — |

**`ctx.target` may be claimed once.** Two plugins claiming it is a load error
naming both, never a silent last-one-wins — the deploy target decides what
"proved" means, and an ambiguous one is worse than none.

## What a plugin may not do

A plugin supplies **capability**. The kernel **judges**. No plugin decides
pass, fail, or rollback — which is exactly what makes it safe for an agent to
write plugins freely. The kernel has no plugin hooks at all; that is a feature.
