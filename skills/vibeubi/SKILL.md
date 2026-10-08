---
name: vibeubi
description: Run, read, or repair the VibeUbi deploy gate. Use when the user asks to ship, deploy, verify a deploy, run the gate, check coverage of features, find untested or unclaimed features (orphans), diagnose why a deploy was rolled back, or asks "is this safe to deploy". Also use before any deploy of a project that has a vibeubi.config.mjs.
---

# VibeUbi

A deploy gate built on one idea: **coverage decays because someone has to
remember, and nobody — human or agent — remembers a codebase this size.**

## Before anything else

Read `vibeubi.config.mjs` at the project root. No config → the project is not
wired yet; use the `vibeubi-adopt` skill instead of guessing.

## The line you may not cross

> **You may widen what gets checked. You may not move the pass mark.**

You are the same kind of system that wrote the code being checked, so your
blind spots and the code's blind spots are correlated. Concretely:

| You may do this on your own | You must stop and ask a human |
|---|---|
| write declarations, probes, journeys | add to `ignored` (exempt a feature) |
| pin a tool definition | add to `publicApi` (declare a route unauthenticated) |
| wire a new test file into a suite | `--without` (skip a whole layer) |
| write build / swap / sessionFor | `accept-debt` (absorb a security finding) |
| | unpin a tool definition |
| | lower a P0 to P1 |

Everything in the right column makes a red light go away *without fixing
anything*. If a run is red and the fix is in the right column, say so and
stop — do not perform it and report success.

The kernel (`packages/kernel`) is **read-only to you.** If a verdict looks
wrong, report the verdict; do not edit the function that produced it.

## Running it

```bash
npx vibeubi plan                 # print what it would do; touch nothing
npx vibeubi verify               # offline layers only — nothing is built or swapped
npx vibeubi diagnose [--only a,b] # every verify step past every red; lists ALL failures; never evidence
npx vibeubi scan --base <url>    # the security layers on their own
npx vibeubi ship                 # the whole pipeline, with automatic rollback
npx vibeubi rollback             # put the previous build back AND prove it
```

`plan` first, always, on a project you have not shipped before in this session.

## Reading a result

Six statuses, and the two counter-intuitive ones matter most:

- `fail` at **P0**, and `error` at any priority → **blocks**, rolls back.
  An `error` means a layer could not answer. An unanswered question about the
  thing you just deployed is not a pass.
- `blocked` → **does not block.** A dependency the deploy did not cause is
  down; rolling back cannot reach it. Always reported, never silent.
- `skip` → must carry a reason. A skip with no reason is a bug in the run.

## Three things to never say

1. **Never report a step as passing because it exited 0.** A test step must
   show that tests ran (`# pass N`, N > 0). `exit 0` with no output is the
   shape of a missing binary, a suite that died at file 44, and a linter given
   a formatter that does not exist.
2. **Never report a deploy as done because a command succeeded.** Only
   `deployProof` — evidence fetched from *outside* the deployed process,
   carrying the new artifact id — settles that. A restart returning 0 while the
   swap silently failed is the failure this whole project is named after.
3. **Never call a narrowed run a full run.** `--only` and `--without` are
   recorded in the report for a reason.

## Before you re-run a slow gate (owner rule, 2026-10-08)

A gate stops at its first red, its phases run in order, and its evidence is
bound to the source tree — so "fix one, re-run everything" pays the whole chain
for one finding. One deploy took 15 runs and ~10 hours that way; five of them
were the same pinned version hardcoded in five places.

1. **Probe first.** After a fix, run the failed step and every step that could
   share its cause on their own — `npx vibeubi diagnose` or `--only a,b` (or the
   project's own equivalent, e.g. `npm run vibeubi:diagnose`). Start the full
   gate only when those are green.
2. **A shared fact changes everywhere at once.** A version, install path, port,
   renamed tool or env var: grep the whole tree for the old value and for
   hardcoded paths before the first run, and fix every copy together. Prefer one
   resolver plus a guard test over N literals.
3. **Never merge into a tree while its gate runs.** Stop, merge, diagnose the
   merged tree, then start the gate.
4. **Say which kind of run it was.** `diagnose` and `--only` are never
   evidence, even all green; only the full gate is (`countsAsEvidence`).
5. **Run everything, then fix.** Acceptance is a plan with dependencies
   (`after: [...]` per item). A red blocks only its dependents — they are
   `blocked`, name the root failure, and wait for the next round — while every
   independent item still runs. Read the report's `plan.fixFirst` and fix all
   of it before the next run. A blocked P0 rolls back like a failed one.

## When a run is red

1. `npx vibeubi why <feature-id>` — what was declared, who declared it, what
   the last verdict was, whether it is exempt.
2. Decide whether it is *this change's* fault. The gate already re-checks P0
   cells once; a cell that passes on re-check is exonerated **and still
   reported**. Do not silence a reported flake.
3. Fix the code. If you believe the check is wrong, say which rule and why —
   changing the rule is a human decision.

## Related skills

- `vibeubi-adopt` — wire a new project, or claim orphans after adding features
- `vibeubi-security` — the S-layers, including the agent/MCP surface
- `vibeubi-diagram` — export a verifiable architecture picture from a run
