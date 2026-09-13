# The security model

Features get forgotten. So do open ports, leaked keys and ungated routes — and
those are worse, because no user ever files a bug about them.

So security is not a bolted-on layer here. It is **the same three axioms in a
second coordinate system**: discover the surface, declare what is deliberate,
get evidence from outside.

## Why this needs saying now

Independent 2026 measurements put AI-generated code between **25% and 45%**
likely to contain a known vulnerability, depending on methodology; Veracode
found 45% of samples introducing an OWASP Top 10 flaw across 100+ models, and
CodeRabbit measured AI code as ~1.9× more likely to introduce a vulnerability
than human-written code.

But volume is the smaller half. The larger half is that **the agent itself is
now attack surface**, and traditional SAST/SCA cannot see it: they read code,
not tool descriptions, memory writes, or inter-agent traffic — which is exactly
where agentic attacks land.

## Layers

| layer | surface | axiom | blocks on |
|---|---|---|---|
| **S0** secrets & config | tree, **`git log -p` history**, `.env*`, compose, Dockerfile, framework config | B + C | new ≥ HIGH |
| **S1** dependencies | `npm audit` / `pip-audit` / trivy + **AIBOM** (models, prompts, skills, MCP servers loaded at runtime) | A | new ≥ HIGH |
| **S2** SAST | every route self-gates or is allow-listed; unsanitised HTML sinks; non-literal SQL; secrets in log calls | B | new ≥ HIGH |
| **S3** DAST | real unauthenticated requests, headers, CORS reflection, open redirect, rate limits, SSRF probes | C | new ≥ HIGH |
| **S4** exposure map | `ss -ltnp` ∪ published ports ∪ k8s Services ∪ URL-valued env | A | unauthenticated listener |
| **S5** agent surface | the tool roster, its pins, its poison, its egress, its approvals | A+B+C | see below |
| **S6** agent config | `.claude/`, `.cursor/`, `AGENTS.md`, hooks, installed plugins | A | new ≥ HIGH |
| **S7** provenance | signed releases for anything loaded at runtime | B | unsigned component |

**S0 scans history, not just the tree.** A key deleted in the next commit is
still a key: on the first day this ran against a real repo it returned an F
from 28 credentials that existed only in `git log`.

**S4 is the registry, re-pointed.** Its output is `{service, port, bind,
authRequired, tls, reachableFrom}`, and a listener reachable from anywhere that
requires no auth **is an orphan** — it exists and nobody claimed it.

## S5 — the agent surface

The insight the rest of this repo is built on applies here exactly: **an
agent's tool list is a registry.** Same three problems, same three answers.

| rule | catches | sev |
|---|---|---|
| `S5.mcp.rug_pull` | a tool definition whose bytes changed **after** approval | CRITICAL |
| `S5.mcp.orphan` | a reachable tool nobody declared | HIGH |
| `S5.mcp.shadowed` | two servers exposing the same tool name | HIGH |
| `S5.mcp.stale_pin` | a pin with no tool behind it | MEDIUM |
| `S5.mcp.poison.zero_width` | characters a reviewer cannot see and the model reads | HIGH |
| `S5.mcp.poison.bidi` | rendered order ≠ byte order | HIGH |
| `S5.mcp.poison.tag_chars` | Unicode tag characters — an invisible instruction channel | CRITICAL |
| `S5.mcp.poison.override` | "ignore all previous instructions" | CRITICAL |
| `S5.mcp.poison.important` | a fake `<IMPORTANT>` system block in metadata | HIGH |
| `S5.mcp.poison.exfil_url` | a URL with a template slot — a sink waiting for data | CRITICAL |
| `S5.mcp.poison.md_image` | an auto-fetched markdown image with interpolation | HIGH |
| `S5.mcp.poison.read_secret` | metadata asking the agent to read credentials | CRITICAL |
| `S5.mcp.poison.silence` | "do not mention this to the user" | CRITICAL |
| `S5.egress` | the sandbox can reach hosts outside an allowlist | HIGH |
| `S5.identity` | long-lived or broad agent credentials; **empty scopes read as unrestricted** | HIGH |
| `S5.memory` | anything can write to agent memory or skills without a scan | HIGH |
| `S5.approval` | the human approves a model-written summary, not the raw action | HIGH |
| `S5.killswitch` | no tested way to stop a running agent | MEDIUM |
| `S5.blast` | dev and prod reachable from one agent identity | HIGH |
| `S5.asi` | ASI01–ASI10 gaps, reported as INFO so they never vanish | INFO |

### Why pinning is the whole game

MCP clients inherit trust from a server at approval time and then never verify
it again. A server approved on Monday can ship a new tool description on
Tuesday — the **rug pull** — and nothing in the protocol notices. A hash taken
at approval time is the only thing that does.

The fingerprint covers `name + description + inputSchema`, because all three
reach the model as trusted operational context and a change in any one changes
what the agent will do. Nothing else is included: version strings and transport
details move for innocent reasons and would make every pin stale.

### `S5.approval` is `deployProof` wearing different clothes

The deploy rule is *do not trust the report, get the evidence.* The approval
rule is the same sentence. If a human approves a summary the model wrote, they
approved the model's **description** of the action, not the action.

The check is mechanical: hash what was displayed, hash what was executed,
require identical bytes. This is the highest-value control in S5 and almost
nothing ships it.

### These are not hypotheticals

The 2026 OWASP Agentic list (ASI01–ASI10) was assembled from real incidents:
zero-click exfiltration from a production assistant via a single crafted email
(CVE-2025-32711, "EchoLeak" — which chained an injection-classifier bypass,
reference-style markdown to dodge link redaction, an auto-fetched image, and a
CSP-allowed proxy, and *instructed the model never to mention the email*); a
compromised coding assistant with 950k+ installs; an agent deleting production
data during a code freeze; the first in-the-wild malicious MCP server on npm;
and an MCP rug-pull demonstrated end to end.

Three of VibeUbi's poison patterns (`md_image`, `silence`, `exfil_url`) exist
specifically because of the EchoLeak chain.

## ASI mapping

| id | risk | where VibeUbi looks |
|---|---|---|
| ASI01 | Agent goal hijack | `S5.mcp.poison.*`, untrusted-content fencing |
| ASI02 | Tool misuse & exploitation | `S5.mcp.*`, parameter-schema drift |
| ASI03 | Identity & privilege abuse | `S5.identity`, `S2.route.ungated` |
| ASI04 | Agentic supply chain | `S1` AIBOM, `S7` provenance, `S5.mcp.rug_pull` |
| ASI05 | Unexpected code execution | `S5.egress`, sandbox mode in `S0` |
| ASI06 | Memory & context poisoning | `S5.memory` |
| ASI07 | Insecure inter-agent comms | `S4` exposure, `S5.identity` |
| ASI08 | Cascading failures | `S5.blast` |
| ASI09 | Human-agent trust exploitation | **`S5.approval`** |
| ASI10 | Rogue agents | `S5.killswitch`, roster drift over time |

Gaps and partials are emitted as INFO (`S5.asi`) so they cost nothing in the
score and never vanish from view.

## Two rules that keep a security gate from being deleted

**1 · Only block on findings this change introduced.** Known debt lives in a
baseline keyed by `sha256(rule | file-or-url | normalised evidence)` — no line
numbers (they move), no timestamps. *A gate that blocks on known debt is a gate
people delete.* But known debt is named in every report, **with its age in
days**, so it cannot quietly become invisible either.

**2 · Never print a secret.** Evidence is masked
(`OPENAI_API_KEY=sk-x…(51 chars)`), the baseline stores fingerprints only, and
a test asserts that a planted key's body appears in no rendered output.
*A scanner that writes a key into a CI log is itself a security incident.*

## The failure this layer nearly repeated

The first version of the security cell answered `pass` whenever the scanner
returned without throwing, and put the grade in a detail string — except it
read `r.grade` while the scanner reported `r.summary.grade`. The detail said
"ran", and **a grade of F printed a green row.**

Same shape as every other incident in this repo: the thing executed, so it
looked fine. Which is why `grade()` is a tested pure function and the cell
asserts on its value, not on the absence of an exception.

## References

- OWASP Top 10 for Agentic Applications 2026 (ASI01–ASI10)
- OWASP Top 10 for LLM Applications 2026
- CVE-2025-32711 (EchoLeak) · CVE-2025-54136 (MCPoison) · postmark-mcp backdoor
- Veracode, *GenAI Code Security* 2026 · CSA, *AI-Generated Code Vulnerability Surge* 2026
