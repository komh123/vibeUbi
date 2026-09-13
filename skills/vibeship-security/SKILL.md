---
name: vibeship-security
description: Run and interpret the VibeShip security layers S0-S7, including the agent and MCP attack surface. Use when the user asks about security scanning, secrets in git history, exposed ports, attack surface, SAST/DAST, MCP tool poisoning, prompt injection defences, agent permissions, OWASP LLM or Agentic (ASI) risks, or asks "is this safe to expose".
---

# Security — the same three axioms, a second coordinate system

Features get forgotten. So do open ports, leaked keys, and ungated routes —
and those are worse, because no user ever reports them.

So security uses the identical structure: **discover the surface → declare
what is deliberate → get evidence from outside.**

```bash
npx vibeship scan                       # offline: S0 S1 S2 S5 S6 S7
npx vibeship scan --base https://host   # adds S3 (DAST) and S4 (exposure)
npx vibeship scan --layer S5            # the agent surface on its own
```

## The layers

| layer | what it looks at | axiom |
|---|---|---|
| **S0** secrets & config | working tree, **`git log -p` history**, `.env*`, compose, Dockerfile, framework config | B + C |
| **S1** dependencies | `npm audit` / `pip-audit` / trivy, plus an **AIBOM**: which models, prompts, skills and MCP servers this system loads | A |
| **S2** SAST | every route self-gates or is allow-listed; unsanitised HTML sinks; non-literal SQL; secrets in log calls | B |
| **S3** DAST | real unauthenticated requests, security headers, CORS reflection, open redirect, rate limits, SSRF probes | C |
| **S4** exposure map | `ss -ltnp` ∪ published ports ∪ k8s Services ∪ URL-valued env → `{service, port, bind, authRequired, tls, reachableFrom}` | A |
| **S5** agent surface | the tool roster, its pins, its poison, its egress — see below | A + B + C |
| **S6** agent config | `.claude/`, `.cursor/`, `AGENTS.md`, hooks, installed plugins | A |
| **S7** provenance | signed releases for anything the agent loads at runtime | B |

**S4 is the security version of the feature registry.** A listener that is
reachable from anywhere and needs no auth is the security version of an
orphan: it exists, and nobody has claimed responsibility for it.

## S5 — the agent surface, which ordinary appsec cannot see

SAST and SCA read code. They cannot see tool descriptions, memory writes, or
inter-agent traffic — which is where agentic attacks actually happen.

| rule | what it catches | why it is not theoretical |
|---|---|---|
| `S5.mcp.rug_pull` | a tool definition whose bytes changed **after** it was approved | clients inherit trust from a server once and never re-verify; the server can ship a new description tomorrow |
| `S5.mcp.orphan` | a tool the agent can reach that nobody declared | the agent-surface orphan |
| `S5.mcp.shadowed` | two servers exposing the same tool name | the agent resolves one and you do not get to know which; the loser may be the one you audited |
| `S5.mcp.poison.*` | zero-width characters, bidi overrides, Unicode tag characters, `<IMPORTANT>` blocks, instruction overrides, exfiltration URLs with template slots, auto-fetched markdown images, "do not mention this to the user" | tool metadata reaches the model as trusted operational context |
| `S5.egress` | the sandbox can reach hosts outside an allowlist | exfiltration needs a sink; deny-by-default egress removes it |
| `S5.identity` | long-lived or broad agent credentials; **empty scopes read as unrestricted** | a hijacked agent is as dangerous as the credentials it holds |
| `S5.memory` | anything can write to agent memory or skills without a scan | poisoned memory steers later behaviour with no visible cause |
| `S5.approval` | the approval UI shows a **model-written summary** rather than the raw action | see below |
| `S5.killswitch` | no tested way to stop a running agent | |
| `S5.blast` | dev and prod reachable from the same agent identity | one agent's compromise propagates |
| `S5.asi` | the ASI01–ASI10 checklist, gaps reported as INFO so they never vanish | |

### `S5.approval` is `deployProof` wearing different clothes

The rule for a deploy is: *do not trust the report, get the evidence.* The rule
for an approval is the same sentence. If the human approves a summary the model
wrote, they approved the model's **description** of the action, not the action.
The check is mechanical: hash what was displayed, hash what was executed, and
require them to be the same bytes.

This is the single highest-value control in S5, and almost nothing ships it.

## Two rules that keep a security gate from being deleted

1. **Only block on findings this change introduced.** Known debt lives in a
   baseline with a fingerprint = `sha256(rule | file-or-url | normalised
   evidence)` — no line numbers, no timestamps. A gate that blocks on known
   debt is a gate people delete. But known debt is **named in every report**,
   with its age in days, so it cannot quietly become invisible either.

2. **Never print a secret.** Evidence is masked
   (`OPENAI_API_KEY=sk-x…(51 chars)`), the baseline stores fingerprints only,
   and a test asserts a planted key's body appears in no rendered output.
   *A scanner that writes a key into a CI log is itself a security incident.*

## Accepting a finding

`accept-debt` is a **narrowing** action. You may prepare the diff and explain
the trade-off; a human accepts it. Treat it as a code review of the baseline,
never as a flag you pass to make a build green.
