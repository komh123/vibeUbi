# Evidence contract review — PR #1

Reviewed main: `6aaf27f83eee0be61010456be959d6871c0ec929`.
Original PR head: `59f65b2b0a486f548d4b7cf3d7d132b784ca1491`.

VibeUbi replaces remembered release checks with discovery, declarations and
observations. Its kernel judges supplied facts; adapters obtain those facts.
The legacy ship pipeline checks the declared proof contract and observes the
new artifact externally. The incremental runner executes a project-declared
dependency graph; it cannot infer whether an arbitrary command actually proves
a deployment. A green build, a reusable artifact and a proved deployment are
different claims.

| Result | What it establishes | What it does not establish |
| --- | --- | --- |
| Full repository verification | Type checks, all unit tests and CLI smoke ran on the recorded tree/runtime | A consumer was deployed |
| Diagnostic / narrowed run | Outcomes of the attempted checks; failures worth fixing | Full gate evidence, even when clean |
| Incremental delivery | The selected declared steps passed, including their prerequisites | Coverage of unselected checks or undeclared deployment obligations |
| Reused step | Declared inputs/command/dependencies match a previous pass and declared artifact pins were re-observed | Fresh live acceptance or external deploy proof |

## History: the problem that moved between boundaries

These conclusions come from the code changes and their tests, not just titles.

| Change | Original failure and actual mechanism | Boundary left to the caller or next change |
| --- | --- | --- |
| `2eefb1a` | Added `sameObserved`: two unreadable values cannot establish agreement | New comparison sites still have to use it; PR #1 used raw equality for fingerprints |
| `17adb4b` | Separated diagnostics (`clean`, `evidence:false`, separate directory) from full gate eligibility; source matching was optional | A caller omitting desired source context did not establish source identity |
| `e6e0d31` | Added validated `after` plans, ready rounds and failed/blocked/not-run outcomes | The legacy acceptance budget stops new rounds, while the active round keeps its own timeout; this is not a hard wall-clock deadline |
| `c85df14`, `190dabc`, `6aaf27f` | Introduced step receipts, then negative input globs; a falsifiable test showed directory allowlists miss a newly added source root | Correct input declarations remain a contract. Output observation occurred after the post-execution source check, and reuse had no post-observation check |
| `ec750c7`, `eb5333d`, `e42f902` | Added interruption checkpoints, explicit build-only baseline control and distinct excluded outcomes | A checkpoint is not a success; a build-only caller still must set `recordBaseline:false` |
| `0d1202c` | Added an ancestry check rejecting a candidate missing published source | The promotion adapter must call it; the generic runner does not inject the check |
| `59f65b2` | Split build/test inputs and added identity probes so test-only edits can reuse pinned builds | Optional build-hash comparison admitted absent/empty identities; new asynchronous probes ran after the old source check |

The recurring issue is the boundary of a claim: **which inputs, which phase,
which observation, and at what time?** Optimizing execution adds branches;
if the success condition remains inside the old branch, the new branch can
publish evidence it never established. More retries do not fix this.

## Corrections and falsifiable checks

1. Gate fingerprint comparisons share the existing unreadable-observation rule
   and require strings. A split build claim requires an expected build hash;
   acceptance requires both halves. A complete whole-tree binding remains valid.
   Valid matching hashes pass; omitted, blank, mismatched and non-string values
   fail. Diagnostic/narrowed/red reports remain ineligible even with good hashes.
2. Fresh and reused paths converge on a source check after artifact observation,
   before publishing a receipt or step pass. A failed/mismatching reuse probe
   must also pass the source check before falling back into a build. Final
   success is checked again after the last step checkpoint, before baseline
   publication.

The regression fixture uses a real identity subprocess on the final step.
It first demonstrates valid execution/reuse, then changes source during the
probe. The invalid run must fail, preserve old receipts/baseline, and avoid a
fallback build with a stale key. Restoring source allows only valid old receipts
to be reused. A separate test changes source at the final checkpoint.

On the original PR code, the new cases produced seven failing tests. Run
`npm run test:evidence-mutations` to deliberately break the guards in temporary
copies and verify that the corresponding regression tests turn red. The working
tree is never mutated by that command.

The first full Node 24 run also exposed an existing CLI-fixture defect: the
nested `node --test` command used the default reporter, so `testRanVerdict`
correctly refused its missing machine-readable count. The suite completed
456/457, with typecheck, smoke and mutations still run. The fixture, root test
script and command example now explicitly request TAP; the verdict was not
relaxed. The search covered all tracked code, fixtures, scripts, examples and
docs (plus the prepared workflow). README already described this runtime
difference: another case of a known contract not reaching a new call site.

## Verification plan

There is no compile/build step for this `.mjs` repository. The check plan is:

| Check | after |
| --- | --- |
| Fingerprint and delivery-boundary diagnostic tests | `[]` |
| Related diagnosis, delivery and input-classification tests | `[]` |
| Targeted mutations | fixed regression diagnostics |
| Full Node 22 and Node 24 type/unit/smoke checks | clean diagnostics and killed mutations |
| Publish PR head | complete local checks on the exact candidate commit |
| Merge | published head still matches the locally verified commit |
| Complete local main checks | fetched merge commit |

Independent checks continue after failures and are reported together. Local
Node-version suites run sequentially because existing blue-green tests share
fixed ports. Record the commit, tree, runtime, observed test counts and source
fingerprint before/after the checks. Verify the fetched merge commit again;
do not present a pre-merge result as evidence for the merged tree.
On 2026-10-30 the owner explicitly selected local verification and repository
pushes instead of a GitHub Actions workflow. No workflow is required for this
PR's merge; this changes the execution location, not the checks or their pass
criteria. Repository checks are not consumer deployment evidence.

## Limits retained deliberately

Hash observations are not a filesystem lock or an atomic snapshot. A caller must
freeze source; a change-and-revert between observations is not detected. Ignored
files, external compiler/configuration inputs and excluded generated files are
not automatically covered. Identity commands must identify the real artifact,
not print a constant. Cache receipts are local trusted state, not signatures.
None of these assumptions is strengthened by setting `ok:true` on a report.

This repair does not change acceptance severity, add exclusions, relax a P0,
rewrite the legacy pipeline, or infer deployment semantics from phase names.

## Follow-up: observations also have a lifetime

On main `dd669b4`, source checks were intact but a final identity command could
finish after a step/total deadline or interruption and still publish success.
The original PR had introduced a separate `execFile` path with a fixed 60-second
timeout; it bypassed the cancellation and process-group control used by ordinary
commands. The same missing boundary affected injected observers. Nine initial
regression cases failed on that main revision, using actual subprocesses and
unchanged input/artifact controls.

Identity commands now reuse `runStep` with a separate stdout capture, so stderr
cannot become part of an artifact identity. Each attempt retains its own logs.
Execution, a reuse probe, fallback and fresh observation share one step deadline
and the remaining total budget. Active-state checks precede fallback/publication
and final baseline publication. Injected observers get a signal and watchdog;
ignoring that signal cannot turn a late return into evidence. Existing valid
receipts remain intact when a later observation is aborted.

Outcome rows now come from `planOutcome`, preserving the distinction between
unstarted independent work (`not-run`) and failed dependencies (`blocked`).
Tests exercise both step and total deadlines, fresh/reuse interruption with a
real grandchild, injected callbacks, independent continuation and interruption
at the last checkpoint. A further two failing cases exposed that clearing the
abort escalation timer when the leader exited left SIGTERM-ignoring descendants
alive. Interrupted groups are now forcibly completed after leader exit; the
fixture proves the child's handler was installed before sending the signal.
Five additional targeted mutations falsify the new
guards; the five original source/fingerprint mutations remain in the same suite.
Validation and publication follow the owner-approved local plan above.

## Follow-up: a link name is not observed output bytes

Main `2d697aa` could reuse a declared output symlink after its target bytes
changed, or publish success for a dangling, cyclic or outside-root target.
`c85df14` introduced one hash function for both source and output observations;
its symlink branch hashed only the link text. Later reuse and identity work
retained that branch. The documentation promised observed output bytes, but the
implementation only established where the link pointed.

Required output observations now hash link text and resolved target contents,
reject unreadable targets and enforce the root boundary on resolved paths.
Directory ancestry detects cycles without rejecting two valid aliases to the
same directory. Both fresh execution and reuse already call this shared entry
point; failed observation can rebuild, but it cannot publish new evidence unless
the resulting outputs are observable. Source-link hashing remains unchanged.

The final twelve-case regression suite has one healthy alias control and eleven
failures on the unmodified main implementation: changed file/directory/nested
link targets, fresh/reuse dangling/cyclic/outside links, and paths escaping
through a symlink parent. Each failure checks a decision or the preservation of
receipts/baseline, not merely a hash helper's return value. Two targeted mutations
remove target-byte observation and resolved containment; the corresponding
tests must turn red. Existing source/fingerprint/lifetime mutations remain.

These observations are not an atomic filesystem snapshot. Callers must keep
artifacts stable while they are being observed, just as source must stay frozen.
Following in-root output links does not automatically declare external build
inputs or establish that a consumer deployment succeeded.

## Follow-up: the declared graph must include the barriers the runner enforces

On main `3208ad6`, preflight and full-only barriers lived in separate scheduler
conditions introduced in `c85df14`. The checklist, cache keys and `planOutcome`
only saw declared `after` edges. As a result, blocked work could appear as
`not-run`, `fixFirst` undercounted the affected work, and changing an implicit
prerequisite did not invalidate dependent receipts. Reordering the topological
result by phase could also hide a contradictory barrier dependency until after
some steps had run.

The selected graph now expands the existing barriers once during checklist
construction. Execution, key construction and outcome attribution consume its
edges. Kernel verdicts are unchanged; full-only checks remain absent from normal
incremental runs, and all independent checks within a barrier still execute.
Expanded cycles are rejected before execution. Declarations are not mutated,
and already-explicit dependency lists retain their existing key representation.

Nine project-neutral fixtures cover incremental/full plan visibility, failure
attribution, independent continuation, valid ordering, cycle refusal and cache
invalidation. Seven failed against the unmodified main; two healthy ordering
controls passed. Three semantic mutations remove the plan edge, discard the
effective graph in execution, and drop prerequisite evidence from cache keys.
The related diagnostic selection covers delivery, input classification and
identity lifetime alongside the new cases. No consumer-specific paths, names
or policy exceptions are part of the implementation or tests.

## Follow-up: preserve field boundaries before hashing

Research checked on 2026-10-30:

- [Node Hash API](https://nodejs.org/docs/latest-v22.x/api/crypto.html#hashupdatedata-inputencoding)
  describes successive updates as streamed data. Calling `update` separately
  does not encode a record boundary.
- [Git object storage](https://git-scm.com/book/en/v2/Git-Internals-Git-Objects)
  describes a header containing object type and content byte length. This is a
  reference for explicit encoding, not a reason to change VibeUbi's hash algorithm.

On main `693311b`, the path hasher introduced in `c85df14` concatenated names,
modes and raw file contents. A binary payload could include the next file's
header. Moving that header between two files produced the exact same byte stream
before SHA-256, despite independently different Git blob identities. Regressions
reproduced stale build reuse, missed source changes during fresh/reused identity
observation, and unchanged output evidence for different artifact bytes.

Searching all production hash constructors found the same boundary problem in
the security finding fingerprint from `80cbd08`: `rule|where|evidence` cannot
distinguish a pipe in a path from one in the evidence. Distinct findings could
therefore share baseline admission. The kernel's tool fingerprint already uses
structured JSON; fixed-width digest prefixes and single-value hashes do not
have this demonstrated ambiguity and were not changed.

The path hasher now frames every field with its type and byte length, including
paths, modes, file bytes, link targets and directory boundaries, under a v2 domain
marker. Finding fingerprints use a v2 JSON tuple while retaining intended date
and whitespace normalization. Hash algorithms, severity and admission verdicts
are unchanged. Old receipts and security baseline IDs are intentionally not
silently migrated; see [the upgrade guide](UPGRADING.md).

The nine new generic cases produced eight assertion failures on original main
and one valid normalization control. Tests prove identical legacy streams before
hashing, independently confirm different file objects with Git, then exercise
the actual delivery and baseline decisions. Two semantic mutations restore the
ambiguous encodings and must turn the corresponding cases red. These checks do
not claim cryptographic collision resistance is perfect or create an atomic
filesystem snapshot; sources and artifacts still must remain stable while read.

## PR #5 byte contract and upgrade audit

The [fingerprint audit](PR5-FINGERPRINT-AUDIT.md) specifies the exact encoding,
producer/consumer paths, old-version counterexamples and migration checks. It
separates ambiguous serialization from lossy observation and hash collisions.
