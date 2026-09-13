# Porting VibeUbi to another project

Three steps. The middle one is the one you cannot skip by automation.

```
1 WIRE    probe the project, write the adapter, list every orphan   ← agent
2 ADOPT   turn each orphan into a declaration                       ← agent
3 SHIP    verify → build → swap → prove → sweep → gate → report     ← deterministic
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

## Porting checklist

- [ ] `vibeubi plan` lists your plugins and prints a proof source
- [ ] `proofContract` passes — the evidence is external and carries the id
- [ ] `vibeubi orphans` finds real, nameable things
- [ ] a deliberately broken proof makes `ship` refuse (test it once, on purpose)
- [ ] `vibeubi guard --action ignore` exits 1
- [ ] a test file added outside every suite makes `verify` name it

The fourth item is worth the ten minutes. A gate you have never seen refuse is
a gate you do not know works.
