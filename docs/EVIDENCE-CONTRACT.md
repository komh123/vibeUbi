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
