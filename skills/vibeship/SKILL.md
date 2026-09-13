---
name: vibeship
description: Run, read, or repair the VibeShip deploy gate. Use when the user asks to ship, deploy, verify a deploy, run the gate, check coverage of features, find untested or unclaimed features (orphans), diagnose why a deploy was rolled back, or asks "is this safe to deploy". Also use before any deploy of a project that has a vibeship.config.mjs.
---

# VibeShip

A deploy gate built on one idea: **coverage decays because someone has to
remember, and nobody — human or agent — remembers a codebase this size.**

## Before anything else

Read `vibeship.config.mjs` at the project root. No config → the project is not
wired yet; use the `vibeship-adopt` skill instead of guessing.

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
npx vibeship plan                 # print what it would do; touch nothing
npx vibeship verify               # offline layers only — nothing is built or swapped
npx vibeship scan --base <url>    # the security layers on their own
npx vibeship ship                 # the whole pipeline, with automatic rollback
npx vibeship rollback             # put the previous build back AND prove it
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

## When a run is red

1. `npx vibeship why <feature-id>` — what was declared, who declared it, what
   the last verdict was, whether it is exempt.
2. Decide whether it is *this change's* fault. The gate already re-checks P0
   cells once; a cell that passes on re-check is exonerated **and still
   reported**. Do not silence a reported flake.
3. Fix the code. If you believe the check is wrong, say which rule and why —
   changing the rule is a human decision.

## Related skills

- `vibeship-adopt` — wire a new project, or claim orphans after adding features
- `vibeship-security` — the S-layers, including the agent/MCP surface
- `vibeship-diagram` — export a verifiable architecture picture from a run
