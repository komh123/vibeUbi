# Commands

Every command has a defined input and a defined artefact, so an agent can
follow it without guessing. `--intent` is free text a human attaches; the agent
reads it, **the gate never does.**

## Wire — once per project

```bash
vibeship init                    # probe → write a vibeship.config.mjs draft
vibeship init --confirm-proof    # the one step a human must look at
```

## Adopt — every time features are added

```bash
vibeship orphans                 # discovered, nobody claimed
vibeship adopt                   # write declarations for all of them
vibeship adopt --only area=auth
vibeship intent <id> "…"         # attach intent; next adopt re-derives probes

vibeship add page /settings/billing \
  --intent "org admins only; with no subscription the save button is disabled, not hidden"
```

`add` should leave behind: the file, the declaration, probes derived from the
intent, a journey if it writes, and the new test file wired into a suite.

## Ask

```bash
vibeship why <id>      # declared by whom, last verdict, exemptions
vibeship orphans       # features and exposed ports with no owner
vibeship roster        # the agent/MCP tool surface: pins, drift, poison
vibeship plan          # what a run would do; touches nothing
```

## Run

```bash
vibeship verify                  # offline layers only; nothing built or swapped
vibeship scan --base <url>       # S0–S7 on their own
vibeship ship                    # the whole pipeline, automatic rollback
vibeship rollback                # previous build back — and proved
vibeship viz --format archify    # diagram IR
```

## Needs a human — the agent may prepare, not perform

```bash
vibeship exempt <id> --reason "…"        # → ignored
vibeship public <route> --reason "…"     # → publicApi
vibeship accept-debt --reason "…"        # → security baseline
vibeship guard --action <a>              # exits 1 if <a> narrows the check
```

## Flags that change what a run means

| flag | effect | recorded |
|---|---|---|
| `--only <sel>` | narrows the sweep | yes — a narrowed run is not a full run |
| `--without <layer> --without-reason "…"` | skips a layer | yes — reason and all |
| `--base <url>` | points live layers somewhere else | yes |

A run with any of these is written into the ledger as such. Six months later
the row says **why** nobody looked, not merely that nobody did.
