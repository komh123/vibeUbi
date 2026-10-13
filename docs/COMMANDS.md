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

## Acceptance plan — run everything, then decide

Acceptance items may declare what they need:

```js
acceptance: {
  phase: "post-swap",
  totalBudgetMs: 900_000,          // optional: how long a broken build may stay live while the plan runs
  items: [
    { id: "acc:login", severity: "P0" },
    { id: "acc:cart",  severity: "P1", after: ["acc:login"] },
    { id: "acc:search", severity: "P1" },
  ],
  fulfil,
}
```

- The plan is validated before anything runs (`testPlan`): an unknown `after`
  id, a self-dependency or a cycle refuses the config, all problems at once.
- Items run in rounds: each round is every item whose prerequisites have
  PASSED. A red blocks only its dependents; independent items still run.
- `after` is a precondition, not shared state — each item still gets its own
  session.
- A blocked P0 gates like a failed P0 (it was never verified); a blocked
  P1/P2 is a warning. Items left when `totalBudgetMs` is spent are `not-run`
  and never undo a deploy on their own.
- The report's `acceptance.plan` carries every item's status, `blockedBy`
  (root failures), `deferred`, `fixFirst` (failures by how much they block)
  and a one-line `headline`. Projects with their own runner use the same
  kernel functions: `testPlan`, `readyToRun`, `planOutcome`.

## Incremental delivery (default for declared delivery projects)

`vibeubi checklist [--since <commit>] [--watch]` refreshes the feature/step list.
`vibeubi ship` (alias `deliver`) runs read-only preflight, affected builds, selected
post-build checks and the project's declared promotion/proof/acceptance steps.
`--full` or `--major "reason"` selects full verification. A normal engine change
is not inherently major. `vibeubi status` reads the atomic checkpoint; reissuing
`ship` resumes verified reusable outputs, never a mutation or live check.

Declare `delivery.features: [{id, covers: [glob], steps: [stepId]}]` and
`delivery.steps: [{id, cmd: [executable, ...args], after: [stepId], phase,
inputs: [glob], outputs: [path], reuse, fullOnly, always, expectsTests, timeoutMs}]`.
`preflight` steps are read-only, cannot depend on a build, and all independent
ones run before build. `fullOnly` checks are a barrier only during a full run.
All independent selected checks finish before the outcome; failed prerequisites
block dependent promotion. Declare rollback inside the bounded promotion adapter.
`mutates: true` prevents reuse. Reuse is opt-in and requires declared nonempty
outputs whose current bytes match the previous success. Inputs default to the
whole source tree; narrow them deliberately to the artifact's actual inputs.

`delivery.generated` lists tracked files produced by the release itself (such as
an append-only release ledger), so these do not look like edits during a run.
`delivery.context` must carry external compiler/configuration version inputs not
represented in source. Never put credentials into declarations or checkpoints.

Reports live under `.vibeubi/delivery/<run>/report.json`; `status.json` is updated
before/after every step, and `heartbeat.json` during a long step. Step logs are
`step-<id>.out`. An interrupted process leaves running evidence, which is never
reused; stale locks are reclaimed only when the recorded PID no longer exists.
`countsAsFullVerification` remains false for this report type: even a full-mode
run records explicit step evidence, rather than impersonating legacy gate output.

`vibeubi/artifacts` exports `buildRetained` for adapters: build, observe identity,
acquire a matching retention lease; at most two attempts for a proven missing
artifact race. Build failures and unknown errors are never retried as GC.
Keep leases until successful acceptance or verified rollback; an archive alone
is recovery material, not proof that an image still exists on the target host.

For remote-only images on a host with kubelet image GC, prefer a direct Docker
archive export over loading into the build host's image store. A tag can be
deleted during a long unpack, before a container lease can be created; retrying
does not close this window. Retain an atomic, content-hashed export file, bind
its config bytes to the build producer's digest, then verify the transferred
hash and the loaded target config/layers before promotion. The adapter must
still exercise the actual target artifact. See Docker's
[archive exporter parameters](https://docs.docker.com/build/exporters/oci-docker/).

Set `delivery.recordBaseline: false` for build-only workflows: preparing an artifact does not advance the deployed change baseline.

An owner-authorized narrowed feature may declare `excludedReason`; it remains visible as excluded and never inherits a different feature's pass. Full mode overrides exclusions. Do not add this to suppress a failed check without explicit owner scope.

A delivery adapter must protect parallel releases too. Use
`assertPromotionLineage` from `vibeubi/delivery` in a read-only preflight, then
repeat it immediately before promotion using the freshly observed public source
identity. Supply `isAncestor(published, candidate)` from the project's source
control. A candidate which omits an already published branch is refused; merge
that source and verify the combined release. Explicit rollback is separate.

Build-cache declarations should include unknown source paths by default (for
example `inputs: ['**', '!docs/**']`), excluding only paths proven unrelated to
that artifact. An allowlist of today's `app/` and `components/` directories can
silently miss tomorrow's `utils/`, locale configuration or new source root.
Include compiler recipes and dependency/submodule identities. Test the pair:
a deployment/documentation edit preserves the key; a new source root changes
it. Changing input rules must invalidate old cache receipts, not relabel their
original provenance.
