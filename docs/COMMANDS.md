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
vibeubi scan                    # S0 S1 S2 S4 by default; --layer S0,S1,S2,S3,S4 --base <url> adds S3 (S5 = vibeubi roster; S6/S7 not implemented)
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

## Coverage gap from commits

`vibeubi coverage-gap --base <ref> [--head <ref>] [--format md|json] [--fail-on-uncovered [all|foreign]]
[--authors-not <a,b>] [--drafts-dir DIR] [--tree head|<ref>|worktree]` reads the commits in `base..head`
and lists the files and new routes/pages/components/APIs that no acceptance item exercises, with a
`record()` draft for each. Exit 0 nothing blocks, 1 blocking gaps, 2 bad usage/config. A person
acknowledges a list with `--ack --by <name> --note <why>`; the acknowledgement expires when the list
or any gapped file changes. Full design and config: [COVERAGE-GAP.md](COVERAGE-GAP.md).

## Incremental delivery (default for declared delivery projects)

`vibeubi checklist [--since <commit>] [--watch]` refreshes the feature/step list.
`vibeubi ship` (alias `deliver`) runs read-only preflight, affected builds, selected
post-build checks and the project's declared promotion/proof/acceptance steps.
`--full` or `--major "reason"` selects full verification. A normal engine change
is not inherently major. `vibeubi status` reads the atomic checkpoint; reissuing
`ship` resumes verified reusable outputs. Mutation steps must declare `mutates: true`;
live observations must leave `reuse` false. The runner cannot infer these semantics
from an arbitrary command.

Declare `delivery.features: [{id, covers: [glob], steps: [stepId]}]` and
`delivery.steps: [{id, cmd: [executable, ...args], after: [stepId], phase,
inputs: [glob], outputs: [path], identity: [cmd], scope, reuse, fullOnly, always, expectsTests, timeoutMs}]`
and, optionally, `delivery.testInputs: [glob]` / `delivery.buildInputs: [glob]` (below).
`preflight` steps are read-only, cannot depend on a build, and all independent
ones run before build. `fullOnly` checks are a barrier only during a full run.
The checklist expands these barriers into the selected steps' `after` lists.
That same graph controls execution, cache dependencies and outcome attribution;
a failed barrier appears in dependents' `blockedBy` and in `fixFirst` counts.
Independent checks within a barrier still run after a sibling fails. A full-only
check depending on an ordinary post-barrier step creates a cycle and is rejected
before any execution. Declare post-build acceptance as an ordinary step with
`after: [buildId]`; `fullOnly` denotes the pre-build full-verification barrier.
All independent selected checks finish before the outcome; failed prerequisites
block dependent promotion. Declare rollback inside the bounded promotion adapter.
`mutates: true` prevents reuse. Reuse is opt-in and requires output paths and/or
an identity command whose observations match the previous success. Inputs default to the
whole source tree; narrow them deliberately to the artifact's actual inputs.

Source, input and output fingerprints use a versioned encoding of typed fields
with byte lengths. File contents can contain arbitrary bytes without being
confused with the next path or file's metadata. Updating from the old encoding
invalidates old cache keys; fresh execution must establish replacement evidence.

Filesystem path names must be valid UTF-8; undecodable names fail observation.
File contents and source-link targets are hashed as raw bytes. Scanner baseline
reports use `unmatched` for absent old IDs; absence does not prove remediation.
See [the byte contract and migration audit](PR5-FINGERPRINT-AUDIT.md).

### Verifying an output against a row (public API)

A consumer that must check an artifact against a delivery row (for example a
native binary before promoting it) imports the identity from `vibeubi/delivery`
instead of re-deriving the hash. A copy of the recipe silently disagrees the day
the encoding moves, as the `sha256(path \0 mode \0 bytes)` form did when
`vibeubi-paths-v2` introduced typed, length-framed fields.

```js
import { outputIdentityOf, fileOutputIdentity, OUTPUT_HASH_VERSION } from 'vibeubi/delivery'

// Observe the filesystem as deliver() does. `outputs` exactly as declared.
const id = await outputIdentityOf(root, ['dist/daemon'])        // === row.outputHash

// Same value for ONE regular file whose bytes and lstat mode you already hold. No I/O.
const same = fileOutputIdentity({ path: 'dist/daemon', mode: (await lstat(file)).mode, bytes })
```

`row.outputHashVersion` (present whenever `outputHash` is) names the encoding the
row used; compare it with `OUTPUT_HASH_VERSION` before trusting a stored row. Output
rules apply: the path must exist and resolve inside `root`, and names must be valid
UTF-8. `path` is the string declared in `outputs`, not an absolute path. The
encoding is pinned by an independent model in `packages/ship/test/output-identity.test.mjs`.

Output pins hash both a symbolic link and the bytes of its resolved target,
including linked directories. Targets must exist and resolve inside the project
root, including when a parent directory is a link. Dangling links, directory
cycles and paths escaping the root cannot publish receipts or establish reuse.
Multiple links to the same directory are allowed when they do not form a cycle.
This does not change source hashing: a tracked source link pins its link text;
external build inputs still need an explicit input/identity contract.

`timeoutMs` covers the selected step's execution, reuse probes and fresh identity
observations together; rebuilding after an invalid pin does not reset it.
Identity commands use the smaller of 60 seconds, the step's remaining time and
the remaining `delivery.totalBudgetMs`. They share process-group termination
with ordinary steps. stdout alone identifies the artifact; stderr is retained
separately in the run's `identity/<step>/<attempt>/` logs. Interruption or an
exhausted budget prevents fallback builds and new success/baseline publication.
An independent check still runs after a step timeout while total time remains;
an unstarted independent check is `not-run` once the total budget expires, and
dependents of a failed prerequisite are `blocked` with `blockedBy`.

Programmatic `identify(step, { root, signal, timeoutMs })` observers receive
cancellation and a bounded wait. Their late result cannot become evidence.
Callbacks must honor `signal` to stop their own side effects; the runner cannot
forcibly terminate arbitrary JavaScript executing inside its process.

### Build inputs vs test inputs (a step's cache key hashes only its own inputs)

One whole-tree hash means an edit to an acceptance script re-triggers a rebuild
whose products cannot have changed. Split the tree instead:

- **buildInputs** — source and config that can change a build product.
- **testInputs** — acceptance scripts, test files, fixtures, docs, generated
  ledgers (`SHIPS.md`...).

```js
delivery: {
  testInputs: ['SHIPS.md', 'scripts/acceptance/**', '**/*.test.ts', 'docs/**'],
  steps: [
    // phase 'build' (or scope: 'build'): the key hashes this step's `inputs`
    // MINUS testInputs. No `inputs` = the whole tree, minus testInputs.
    { id: 'web-build', phase: 'build', reuse: true,
      outputs: ['dist/web'],                       // pin 1: output bytes
      identity: ['docker', 'image', 'inspect', '--format', '{{.Id}}', 'app:web'] },  // pin 2: artifact identity (stdout)
    // every other step keys on build + test inputs
    { id: 'web-accept', after: ['web-build'],
      cmd: ['node', '--test', '--test-reporter=tap', 'scripts/acceptance/web.test.mjs'], expectsTests: true },
  ],
}
```

Rules:

1. **Default is today's behaviour.** No `testInputs` = every file is a build
   input, keys are byte-identical to before, nothing is reused that was not.
2. **Fail-safe classification.** A file is a testInput only if a `testInputs` glob
   matches it. A file in no list is a build input (an unknown file rebuilds). The
   kernel's `ALWAYS_BUILD_INPUTS` — lockfiles, `package.json`, Dockerfiles,
   `*.config.*`, `tsconfig*.json`, `.env*` templates — are build inputs even if a
   `testInputs` glob such as `**` also matches them; a project may add its own
   always-build globs with `delivery.buildInputs`.
3. **Reuse = the same artifact, not a rebuild that should be identical.** When
   only testInputs changed, a `reuse: true` step is reported `execution: "reused"`
   only if every declared pin still verifies against the receipt of the earlier
   success: `outputs` bytes hash equal, and the `identity` command prints the same
   non-empty identity (image digest, BUILD_ID, ...). A missing receipt, a missing
   or changed output, a failing/empty/different identity probe, or a step with
   neither pin means the step **runs**. A build that runs but yields no observable
   identity fails (an artifact nobody can identify cannot be pinned later).
4. **Acceptance in this example always re-runs** (it has no `reuse`) and its
   dependency key includes the pinned identity, so it is tied to the artifact it
   ran against. The generic runner does not prohibit `reuse` by phase name;
   projects must not opt live observations into reuse.
5. Changing `testInputs`/`buildInputs` changes every key: old receipts are not
   relabelled.

Reports carry `buildInputsHash` and `testInputsHash` (and `sourceTree`, the whole
tree), and each step row records `execution: "ran" | "reused"`, `key`,
`outputHash`, `artifact` (the pinned identity) and `scope`. A gate-shaped report
with `ok` and `phase` is checked using
`countsAsEvidence(report, { phase, buildInputsHash, testInputsHash })`: build
requires a nonempty expected AND observed `buildInputsHash`; every other phase
requires both hashes. Empty, whitespace-only and non-string fingerprints are
unreadable, even if equal. A nonempty `sourceTree` binding can instead bind the
whole tree; an explicitly requested split binding must still be satisfied.
Build/split reports without a requested binding are refused. Legacy reports
without fingerprints and without a requested binding receive only an eligibility
check, not source validation or proof of a deployment. Kernel helpers:
`inputClass`, `splitInputs`, `ALWAYS_BUILD_INPUTS`, `globMatches`.

**Failed rows keep their evidence.** A failed step's `reason` is only the last
1200 characters of its output. The row also carries `logPath`, the absolute path
of the full `step-<id>.out` under `.vibeubi/delivery/<run>/`, persisted in
`report.json` and `status.json`, so the evidence can still be found after a
rollback. An injected `execute` can supply its own path (`error.logPath` on a
thrown error, or `log` in an `{ ok: false }` result); no path is invented when
there is none. Output is read with terminal colour codes stripped (`stripAnsi`),
so an inherited `FORCE_COLOR` cannot change a verdict.

**Skipped (opt-in).** An executor may report a step it could not run because of
the environment, not the change (an unfixed permission, an unprovisioned site):

```js
execute: async step => ({ ok: false, status: 'skipped', category: 'environment-blocked', reason: 'git write-tree denied on this site' })
```

The row becomes `status: "skipped"` with `reason` and optional `category`; it
writes no receipt, its dependents are `blocked` by it (`blockedBy`), independent
steps still run, and `outcome.skipped` lists it. A skipped step is neither a pass
nor a failure to fix, so the delivery is **not** `passed` (no baseline is
recorded) and `countsAsEvidence` refuses any report in which a step is skipped.
A reason is required, and `ok: true` together with `status: "skipped"` is a
failure, not a pass. Nothing changes for a project that never returns it. The
kernel's `planOutcome(items, results, { skipped: true })` is the same opt-in;
without the option a `skipped` result is read exactly as before.

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
It has `status`, not `ok`/`phase`, and cannot be passed directly to
`countsAsEvidence` as a full gate report. Do not synthesize `ok: true` to erase
that distinction. `--full` selects all configured delivery steps; it does not
invent missing promotion, external proof or rollback steps. Those remain the
project adapter's contract.

Source is checked before work, after a reuse probe (including failed probes),
after fresh execution and all output/identity observations, and before final
success/baseline publication. A source edit invalidates the observation before
it can publish a new receipt. These checks cover the source files enumerated by
Git except `delivery.generated`; they are observations, not an OS write lock.
Keep the worktree frozen. Ignored/external inputs and useful artifact identities
must still be declared correctly. See [the evidence contract review](EVIDENCE-CONTRACT.md).

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
