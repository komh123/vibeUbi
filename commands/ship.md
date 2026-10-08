---
description: Run the full gate: verify → [pre-swap-health] → build → swap → prove → sweep → gate → probe → [post-swap acceptance] → report, with automatic rollback.
allowed-tools: Bash, Read, Grep, Glob
---

Run the full gate: verify → [pre-swap-health] → build → swap → prove → sweep → gate → probe → [post-swap acceptance] → report, with automatic rollback.

Use the `vibeubi` skill for how to read the result and for the line you may not cross.

If a previous run was red: do NOT re-run this first. Run `/diagnose` (or `--only` the failed
and related steps) and fix everything it lists; ship only when that is clean.

```bash
npx vibeubi ship $ARGUMENTS
```
