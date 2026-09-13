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
