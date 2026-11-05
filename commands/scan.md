---
description: Run the implemented security layers (default S0, S1, S2, S4; S3 with --base).
allowed-tools: Bash, Read, Grep, Glob
---

Run the implemented security layers S0–S4 (default S0, S1, S2, S4; add S3 with `--layer S0,S1,S2,S3,S4 --base <url>`). The agent and MCP surface (S5) is `vibeubi roster`. S6 and S7 are specified in `docs/SECURITY.md` but not implemented.

Use the `vibeubi` skill for how to read the result and for the line you may not cross.

```bash
npx vibeubi scan $ARGUMENTS
```
