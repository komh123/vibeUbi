# VibeUbi — agent instructions

This file is read by agent harnesses that do not load Claude Code skills
(Codex, Cursor, opencode, Zed, and others). It is the short version of
`skills/vibeubi/SKILL.md`; that file is the long one.

## What this repository is

A deploy gate whose one idea is: **coverage decays because someone has to
remember, and nobody — human or agent — remembers a codebase this size.**

Three axioms, applied to features and to the security surface alike:

- **A · discovery replaces memory** — the tool finds what exists
- **B · declaration replaces memory** — meaning is written down once, and
  absence is an error
- **C · evidence replaces memory** — never trust a report of success; require
  a fact observed from outside

## The line you may not cross

> **You may widen what gets checked. You may not move the pass mark.**

Automatic: write declarations, probes, journeys, adapters; pin tool
definitions; wire test files into suites.

**Requires a human, every time:** `ignored`, `publicApi`, `--without`,
`accept-debt`, unpinning a tool definition, lowering a P0.

Each of those makes a red light disappear without fixing anything. If a run is
red and the fix is in that list, say so and stop.

`packages/kernel/**` is read-only to you. Report a verdict you disagree with;
never edit the function that produced it.

## Commands

```bash
npx vibeubi plan | verify | scan | ship | rollback
npx vibeubi init | adopt | orphans | why <id> | viz
```

## Rules for reporting

- A step that exited 0 with no evidence that tests ran has **not passed.**
- A deploy is done only when evidence fetched from **outside** the deployed
  process carries the new artifact id.
- A narrowed run (`--only`, `--without`) is never a full run. Say which.

## Two questions that have found more defects here than any tool

Both came out of a week of cross-checking with another session's tree. Between
us, thirteen defects of one family: **a control that looks like a control.**
Every one type-checked, read correctly, and did nothing. None was visible to a
compiler or to reading the line.

### 1. "What is this used for, and does anything verify THAT?"

Ask it of any constant, flag or field — especially one that already has a test.

| what was pinned | what nothing checked |
|---|---|
| `DIST_ENV_VAR === "NEXT_DIST_DIR"` | that the directory it names is not the live one |
| a counter returning a number | that it counts |
| a type alias that compiles | that it still narrows |
| `config.budgets` declared | that anything reads it |
| a comment warning about a pipe | that the code below it does not pipe |

The shape is always the same: **the thing that looks like verification is
testing an identity rather than a relation.**

### 2. "Where would the WRONG predicate disagree?"

When pinning a predicate, pin the point where the naive one diverges — or the
test can pass for a reason that has nothing to do with the property.

Three real cases in one week:

- `heapMb < default` — asserted on a machine size where both sides clamped to
  the ceiling, so the two numbers could never differ. Vacuous, and green.
- `reserveMb` biting — same mistake, 32 GB instead of 12 GB.
- `observed` — the naive `state !== "not-here"` returns true for `unmeasured`.
  The test now asserts the naive predicate DISAGREES there, so renaming a state
  cannot quietly empty it.

A corollary worth its own line: **the risk is not in understanding a thing, it
is in DERIVING from it.** The author of a new metric reaches for the widest
negation to hand. Where a distinction is load-bearing, export the predicate so
the derivation cannot be re-made downstream — see `isObservation`.

### Killing processes

Never match on a command line. `pgrep -f X` and `pkill -f X` match the shell
that is doing the matching, so `until ! pgrep -f "tsc"; do sleep 15; done` can
never finish — its own argv contains the pattern. Observed elsewhere on this
machine: three such waiters alive for eight hours, each waking every 15s,
reported upstream as "background work still running".

This tree is structurally immune — every kill here goes through a pid or a
pidfile (`process.kill(-child.pid)`), and there is no `pgrep` in it. Keep it
that way. To identify a real process, read `/proc/<pid>/exe`, not its argv.

## Repo layout

```
packages/kernel      every decision, zero I/O, 46 tests — the product
packages/registry    discovery + declaration + the orphan rule
packages/security    S0–S7, including the agent/MCP surface
packages/adapters    per-stack plugins (DSH/cordis shape: name + apply)
packages/viz         registry → diagram IR (archify, mermaid, neutral)
apps/console         a browser UI that triggers a run and watches it
skills/ commands/    harness packaging
docs/                ARCHITECTURE, SECURITY, COMMANDS, PLUGINS, PORTING
```
