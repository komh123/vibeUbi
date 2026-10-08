# Commands

Every command has a defined input and a defined artefact, so an agent can
follow it without guessing. `--intent` is free text a human attaches; the agent
reads it, **the gate never does.**

## Wire — once per project

```bash
vibeubi init                    # probe → write a vibeubi.config.mjs draft
vibeubi init --confirm-proof    # the one step a human must look at
```

## Adopt — every time features are added

```bash
vibeubi orphans                 # discovered, nobody claimed
vibeubi adopt                   # write declarations for all of them
vibeubi adopt --only area=auth
vibeubi intent <id> "…"         # attach intent; next adopt re-derives probes

vibeubi add page /settings/billing \
  --intent "org admins only; with no subscription the save button is disabled, not hidden"
```

`add` should leave behind: the file, the declaration, probes derived from the
intent, a journey if it writes, and the new test file wired into a suite.

## Ask

```bash
vibeubi why <id>      # declared by whom, last verdict, exemptions
vibeubi orphans       # features and exposed ports with no owner
vibeubi roster        # the agent/MCP tool surface: pins, drift, poison
vibeubi plan          # what a run would do; touches nothing
```

## Run

```bash
vibeubi verify                  # offline layers only; nothing built or swapped
vibeubi scan --base <url>       # S0–S7 on their own
vibeubi diagnose [--only a,b]   # EVERY verify step past every red; lists all failures; never evidence
vibeubi ship                    # the whole pipeline, automatic rollback
vibeubi rollback                # previous build back — and proved
vibeubi viz --format archify    # diagram IR
```

### What `ship` does, in order

```
verify → [pre-swap-health] → build → swap → prove → sweep → gate → probe → [post-swap acceptance] → report
```

`[ ]` steps exist only if the project declares `acceptance` (see PORTING.md);
otherwise they are skipped and a ship is what it always was. The order is a
safety property — see ARCHITECTURE.md.

| step | mutates | a failure |
|---|---|---|
| `pre-swap-health` | no | **refuses**; nothing was built, swapped or restarted, so nothing is rolled back |
| `gate`, `probe`, `post-swap acceptance` | yes | P0 red or error → **rolls back**, and the rollback is proved from outside |
| a P1/P2 acceptance red | — | recorded in `report.json` (`acceptance.warnings`) and warned; does not roll back |
| a P0 that failed and then passed on retry | — | ships, reported `flaky` (`acceptance.flaky`) |

`report.json` carries an `acceptance` block (phase, verified/unverified, `failed`
with item ids, `warnings`, `flaky`) and the acceptance cells (`layer:
"acceptance"`) beside every other cell. `vibeubi plan` marks the optional steps.

## Needs a human — the agent may prepare, not perform

```bash
vibeubi exempt <id> --reason "…"        # → ignored
vibeubi public <route> --reason "…"     # → publicApi
vibeubi accept-debt --reason "…"        # → security baseline
vibeubi guard --action <a>              # exits 1 if <a> narrows the check
```

## Flags that change what a run means

| flag | effect | recorded |
|---|---|---|
| `--only <sel>` | narrows the sweep | yes — a narrowed run is not a full run |
| `--without <layer> --without-reason "…"` | skips a layer | yes — reason and all |
| `--base <url>` | points live layers somewhere else | yes |

A run with any of these is written into the ledger as such. Six months later
the row says **why** nobody looked, not merely that nobody did.

## Diagnose — before a slow gate

```bash
vibeubi diagnose                # every verify step, no stop at the first red, nothing mutated
vibeubi diagnose --only lib,ui  # just these
```

Writes `.vibeubi/diagnostics/<time>/report.json` with `kind: "diagnostic"`,
`evidence: false`, every failure and its reason. Exit 0 only when all passed —
and even then the next command is `vibeubi ship`, because a step that ran after
an earlier red may have tested something the red already invalidated.
A project that keeps its own runner should ask `countsAsEvidence(report,
{ phase, sourceTree })` from `vibeubi/kernel` instead of reading `report.ok`.
