# Porting VibeUbi to another project

Three steps. The middle one is the one you cannot skip by automation.

```
1 WIRE    probe the project, write the adapter, list every orphan   ← agent
2 ADOPT   turn each orphan into a declaration                       ← agent
3 SHIP    verify → build → swap → prove → sweep → gate → probe → report ← deterministic
```

## 1 · Wire

`vibeubi init` writes a `vibeubi.config.mjs` draft. Fill in the framework,
where routes live, what roles exist and how to mint a session for each, how the
project builds and swaps, and what listens on a port.

Then stop at `proof`.

**`proof` is the only field where a wrong answer produces no error anywhere.**
Every other mistake surfaces as a red cell. A bad proof just quietly makes the
gate meaningless. So `vibeubi init --confirm-proof` exists to put it in front
of a human once.

```js
ctx.target({
  proofClaim: { external: true, carriesArtifactId: true, source: "…" },
  async proof({ base, expected, previous }) {
    const res = await fetch(`${base}/version`)
    return { expected, previous, observed: await res.text() }
  },
})
```

`proofContract()` rejects a claim that is not external or cannot carry the
artifact id — checked at wiring time, not at deploy time.

## 2 · Adopt

Declaring 700 routes by hand is why adoption projects die. So the pattern is
**a safe default plus named exceptions**:

- every API route defaults to *"unauthenticated must be refused"*
- widening it means an entry in `publicApi` **with a reason**
- a listed path with no route behind it is an **error**, because that is how a
  public route survives a rename

Apply the same shape to each new feature kind you add.

## 3 · Ship

Nothing to configure. The kernel decides; the adapter acts.

## 3b · Acceptance — functional behaviour, if the project has any worth gating

Optional. Without it a ship is exactly what it was. With it, the order is

```
verify → [pre-swap-health] → build → swap → prove → sweep → gate → probe → [post-swap acceptance] → report
```

Declare it once, on the project config (`vibeubi.config.mjs`) **or** on the
target adapter (`ctx.target({ …, acceptance })`). Both is refused — two
declarations and no rule for which one is the gate.

```js
acceptance: {
  phase: "post-swap",                        // "post-swap" | "pre-swap-health" — nothing else
  items: [
    { id: "acc:chat-answers", severity: "P0", attempts: 2 },   // P0 red → roll back (and prove it)
    { id: "acc:csv-export",   severity: "P1" },                // P1/P2 red → recorded, warned, ships
  ],
  // vibeUbi writes the ORDER, your function does the work and returns the
  // RESULT. Same shape as the probe's: { skill, artifactId, observedArtifact?,
  // observed: [{ id, verdict: PASS|FAIL|BLOCKED|…, why? }] }.
  async fulfil(order, { signal, attempt }) { /* run your scenarios against order.base */ },
}
```

| field | required | meaning |
|---|---|---|
| `phase` | yes | `post-swap`: judged against the NEW build, rolls back on a P0 red. `pre-swap-health`: liveness only, before anything is built. |
| `items[].id` | yes, unique | echoed back in the result row, and named in the report and the outcome |
| `items[].severity` | **yes — never defaulted** | `P0` / `P1` / `P2`. A missing one is refused at wiring time: defaulting to P0 makes a decoration roll back deploys, defaulting to P2 makes a rollback gate that cannot roll back |
| `items[].attempts` | no, default **1** | P0 only, 1–5. A failed P0 is asked about again before it counts; a pass-on-retry ships and is reported as **`flaky`** with the failure it overwrote — never silently green |
| `items[].judges` | pre-swap: yes | `"health"` or `"behaviour"` |
| `fulfil` | yes | produces the result. `signal` aborts at the time budget |
| `timeBudgetMs` | pre-swap: yes (≤ 120 000) | post-swap: optional, capped by the step budget. A fulfiller that overruns is stopped, and that is a failure, not a hang |
| `healthOnly` | pre-swap: yes | must be declared. `true` — the phase may not assert feature behaviour |
| `staging` | no, pre-swap only | `{ base }`, a separate instance. See below |
| `skill` | no | name echoed in the result; default `"acceptance"` |

What **pre-swap-health** is for: *can we even try?* — login works, one short
request answers, the db / model / sandbox respond. It runs after `verify` and
before `build`, so a failure **refuses** the ship while nothing has been built,
swapped or restarted: there is nothing to roll back, and the outcome says so. It
judges the build being replaced and the dependencies, not your feature.

**Declaring a functional check before the swap is refused**, with SKILL-STEP's
argument: before the swap `base` is still the previous build, so a pre-swap pass
judges the build you are replacing — old-build flakiness blocks the new build,
and behaviour that exists only in the new one fails against the old. That covers
a `pre-…` phase other than `pre-swap-health`, `healthOnly` anything but `true`,
and any item with `judges: "behaviour"` even under `healthOnly: true`.

The one exception is `staging: { base }` where `base` differs from the
production `base`. It is allowed, **with a warning on every run**: vibeUbi
cannot see which build staging holds, so that is your promise and the report
records it.

**Writing the result.** Echo `order.artifactId` back as `artifactId`. Set
`observedArtifact` **only** if you read it off the site under test — it is
compared with the order's, and a made-up one is the same as a wrong one. Before
the swap, `order.artifactId` is whatever the base serves *now* (the build being
replaced); if the adapter cannot read it, it is `pre-swap:<run start>` and you
should omit `observedArtifact`. `timeBudgetMs` is **per round**: with
`attempts: 3` the worst case is three times the budget. A retry may turn a
`FAIL` into a pass (reported `flaky`) and nothing else — a fail followed by
`BLOCKED` stays a failure. Before the swap the base is also looked at first, by
vibeUbi: a base that is down refuses without asking your function.

Result states are the probe's — same judge, same `verdictFor`: only `FAIL`
rolls back after the swap; `BLOCKED` / not reported are counted as unverified
and printed, not rolled back (rolling back a good deploy for a broken fixture
is worse than the gap). Before the swap the same absence refuses, because that
costs nothing.

## Porting checklist

- [ ] `vibeubi plan` lists your plugins and prints a proof source
- [ ] `proofContract` passes — the evidence is external and carries the id
- [ ] `vibeubi orphans` finds real, nameable things
- [ ] a deliberately broken proof makes `ship` refuse (test it once, on purpose)
- [ ] `vibeubi guard --action ignore` exits 1
- [ ] a test file added outside every suite makes `verify` name it
- [ ] if you declared `acceptance`: a deliberately failing P0 item rolls back and the rollback is proved
- [ ] and a `pre-swap` functional item is refused (`vibeubi plan` shows the steps; try it once, on purpose)

The fourth item is worth the ten minutes. A gate you have never seen refuse is
a gate you do not know works.
