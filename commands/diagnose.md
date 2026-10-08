---
description: Run every verify step past every red and list ALL failures — find everything in one run before paying for the full gate. Never deploy evidence.
allowed-tools: Bash, Read, Grep, Glob
---

Run every verify step without stopping at the first red, and list every failure with its reason.

Use this **before** re-running a slow gate after a fix, and after merging other work.
The report goes to `.vibeubi/diagnostics/` and is never deploy evidence, even when
every step passed — when it is clean, the next command is the real gate.

If the project has its own runner (for example `npm run vibeubi:diagnose`), use that.

Use the `vibeubi` skill for the rules ("Before you re-run a slow gate").

```bash
npx vibeubi diagnose $ARGUMENTS
```
