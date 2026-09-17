# VibeUbi

**A deploy gate that removes the need to remember.**

Not a cheaper way to run tests. A fix for a structural problem: in a codebase
nobody — no human, and certainly no agent — holds in their head, **coverage
decays silently.** Features decay. So does the security surface.

```bash
npx vibeubi plan        # what a run would do; touches nothing
npx vibeubi orphans     # everything discovered that nobody claimed
npx vibeubi ship        # verify → build → swap → prove → sweep → gate → report
```

---

## Why "remembering" is the real problem

Automating tests lowers the price per run. It does not stop coverage from
decaying, because *what to test* still lives in someone's head. Feature #847
ships and nothing anywhere says it is untested.

People do not remember "everything that exists". They remember "what they
touched recently". So coverage is a function of **who happened to remember
what, last week** — and that function does not scale with codebase size.

Three things make this worse the moment an agent is writing the code:

- New surface appears faster than any mental model updates.
- **The author has no memory at all.** A fresh session recalls nothing about
  last week. "Remembering" is not merely unreliable for an agent — it is
  structurally absent.
- The model that wrote the code is the model that reviews it. The blind spots
  are correlated, so the judge must not be a model. **VibeUbi's kernel
  contains zero lines of LLM.**

## Three axioms

| | replaces memory with | governs | examples |
|---|---|---|---|
| **A** | **discovery** | *existence* | walk the tree for pages, routes, tools; `ss -ltnp` for open ports |
| **B** | **declaration** | *meaning* | area, role, priority, probes — and **absence is an error** |
| **C** | **evidence** | *outcome* | never trust a report of success; observe a fact from outside |

C is the part other tools do not have. Argo Rollouts, Flagger and Checkly watch
*metrics*. VibeUbi watches a **feature matrix and an exposure map**, and for
"did this deploy happen" it demands an independent fact.

## The one rule that will not bend

```
deployProof:
  1. the evidence is fetched from OUTSIDE the process being deployed
  2. the evidence can contain the artifact id
```

Not the build's exit code. Not `systemctl restart` returning 0. Not HTTP 200.
Not the pipeline's own report. A restart can succeed while the swap silently
did not — and then *every* signal except this one says the deploy worked.

| stack | a proof | not a proof |
|---|---|---|
| Next.js | `BUILD_ID` in the served page's asset paths | the build's exit code |
| any HTTP service | `/version` echoing the git sha | 200 from `/health` |
| Kubernetes | in-pod file hash **+ pod age** | `kubectl rollout status` exit 0 |
| container | the running container's image digest | `docker compose up` exit 0 |

## Security is the same axioms, a second coordinate system

`S4`'s exposure map is the security version of the feature registry: a listener
reachable from anywhere that needs no auth **is an orphan**.

`S5` covers what SAST and SCA structurally cannot see — the agent surface:

- **`S5.mcp.rug_pull`** — a tool definition whose bytes changed *after* it was
  approved. MCP clients inherit trust once and never re-verify; a hash taken at
  approval time is the only thing that notices.
- **`S5.mcp.orphan` / `shadowed`** — a reachable tool nobody declared; two
  servers serving the same tool name.
- **`S5.mcp.poison.*`** — zero-width characters, bidi overrides, Unicode tag
  characters, `<IMPORTANT>` blocks, instruction overrides, exfiltration URLs
  with template slots, auto-fetched markdown images, *"do not mention this to
  the user"*.
- **`S5.approval`** — does the human approve the **raw action**, or a summary
  the model wrote? That is `deployProof` wearing different clothes.

Full model: [`docs/SECURITY.md`](docs/SECURITY.md).

## Built for agents to drive

Steps 1 (wire) and 2 (adopt) are meant to be run *by* an agent. Which makes one
rule load-bearing:

> **An agent may widen what gets checked. It may not move the pass mark.**

| automatic | needs a human, every time |
|---|---|
| write declarations, probes, journeys | `ignored` — exempt a feature |
| pin a tool definition | `publicApi` — declare a route unauthenticated |
| wire a test file into a suite | `--without` — skip a layer |
| write build / swap / sessionFor | `accept-debt` — absorb a finding |
| | unpin a tool · lower a P0 |

Everything in the right column makes a red light disappear **without fixing
anything** — the cheapest move available to a model optimising for "the command
succeeded". `vibeubi guard --action <a>` enforces the split, and
`packages/kernel/**` is read-only to agents.

## Install

**Claude Code / Copilot CLI** — this repo is a plugin:

```
/plugin marketplace add komh123/VibeUbi
/plugin install vibeubi
```

**Anything else** — `AGENTS.md` at the root, plus the CLI:

```bash
npm i -D vibeubi && npx vibeubi init
```

Skills: `vibeubi` · `vibeubi-adopt` · `vibeubi-security` · `vibeubi-diagram`.

## Extending it

Plugins are shaped like DSH/cordis plugins — the smallest contract that works
in every host:

```js
export const name = "vibeubi-fastapi"
export function apply(ctx, config = {}) {
  if (!config.root) return                 // not configured → silent no-op
  ctx.discover("route", async () => [...]) // A
  ctx.target({ proofClaim, proof })        // C
  ctx.on("dispose", () => {})
}
```

**A plugin never throws into the host loop.** A capability that dies becomes an
`error` cell — it cannot silently delete a check, and it cannot abort a run.

## Layout

```
packages/kernel      every decision, zero I/O, 91 tests — the product
packages/registry    discovery + declaration + the orphan rule
packages/security    S0–S7 rule catalogue
packages/adapters    per-stack plugins
packages/viz         registry → diagram IR (archify · mermaid · neutral)
bin/vibeubi.mjs     the CLI every harness can fall back to
```

```bash
npm run verify    # 91 unit tests + 5 end-to-end smoke checks
```

### What is implemented today

`init · orphans · scan · roster · viz · plan · guard`

`adopt`, `add`, `intent`, `why`, `verify`, `ship` and `rollback` are the
intended flow, described in the skills and in `docs/COMMANDS.md`, and the
kernel decisions they need are built and tested — but those CLI subcommands
are not written yet. Where a document describes them, it is describing the
design, not the current binary.

MIT.

---

## Reading

| | |
|---|---|
| [`docs/WHY.html`](docs/WHY.html) | the full argument — ten kinds of remembering, three axioms, the security model, the commercial split. Open it in a browser. |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | rings, statuses, why judging early is provably safe |
| [`docs/SECURITY.md`](docs/SECURITY.md) | S0–S7, the agent surface, ASI mapping |
| [`docs/COMMANDS.md`](docs/COMMANDS.md) | every command, and which ones need a human |
| [`docs/PLUGINS.md`](docs/PLUGINS.md) | the DSH-shaped extension contract |
| [`docs/INIT.md`](docs/INIT.md) | what `ubi init` works out on its own, and the one field it refuses to invent |
| [`docs/PORTING.md`](docs/PORTING.md) | wiring a new project, and the porting checklist |
| [`docs/DIAGRAMS.md`](docs/DIAGRAMS.md) | archify and any other diagram skill |

## A note on the name

`vibeubi` is **taken** on npm (2025) and there are 11+ public
`vibeubi-*` repositories under one owner — including `vibeubi-scanner`, a
security scanner, and `vibeubi-optimizer`, a rollback-friendly optimisation
workflow. Both overlap this project's positioning. `vibeubi.dev` and
`vibeubi.com` both resolve.

Fine for a private repo. Worth revisiting before any public release — not for
legal reasons, but because the first page of results for the name belongs to
someone else.

## Runtimes it is actually tested on

| | tests | typecheck | smoke | CLI |
| --- | --- | --- | --- | --- |
| **Node 18.19** | 267 pass | ✓ | 5/5 | ✓ |
| **Node 22.22** | 267 pass | ✓ | 5/5 | ✓ |
| **Node 24.21** | 267 pass | ✓ | 5/5 | ✓ |

`engines` says `>=18.17`. Three versions run is not the same as "every version
works" — 20 is untested, and so is anything newer than 24.21. What the three
buy is the range's ends plus one point inside it, which is where the two
portability defects found so far actually lived: `node --test <directory>` walks
directories on 18 and does not on 22 (the whole suite was 5/5 red on 22 until a
glob replaced it), and Node 24's default test reporter is no longer TAP, so
`--test-reporter=tap` is needed to get comparable counts.

No API removed in 20/22/24 is used: no `url.parse`, no `util.isArray`, no
`new Buffer()`, no `process.binding`.

## What belongs here, and what belongs in your project

This repository is **the architecture and the flow**. It is deliberately not a
package that tries to fit every codebase, because the interesting part of
adopting it is exactly the part that differs: an agent probing a project,
guessing at the wiring, being told it guessed wrong, and trying again. That
loop belongs to the project, not to the library.

| here | in your project |
| --- | --- |
| the kernel — what "passed", "rolled back", "proved" mean | your `vibeubi.config.mjs` |
| the pipeline and its steps | your declarations: priority, role, probes |
| adapters for a stack — Express, Next.js, k8s | your `gateTokens`, your `versionPath` |
| the rules, and what they refuse to gate on | your accepted debt, with reasons and dates |
| the contracts: proof, admission, skill step | anything that names your hosts, routes or secrets |

Two consequences worth stating plainly, because both were violated before this
line was drawn:

- **A finding about somebody's codebase is not an example.** A config carrying
  real absolute paths, real leaked-key fingerprints and real accepted debt is
  that project's file that happens to be sitting in a library. It moved out.
- **A demo built from one project's recorded run is not a feature.** It is a
  good way to show what the pipeline does and a bad thing to ship as though any
  project could use it. It moved out too.

`examples/example.config.mjs` is a template. Every value in it is a placeholder,
and it is annotated with *why* each field exists rather than what one project
happened to put there.

When you improve something, the question that decides where it goes is: **would
this be true for a project I have never seen?** If yes, it belongs here. If it
is true because of how one codebase is built, it belongs with that codebase.

## Proven on a project it had never seen

VibeUbi was pointed at an **Express + React + k8s** application — a completely
different stack from the Next.js one it was extracted from — with a config kept
OUTSIDE that repository, so zero files were written into it.

```bash
npx vibeubi scan --root ../their-project --config ./their-project.config.mjs --layer S0,S2,S4
```

First run, nothing declared by hand:

- **66 API routes and 7 pages discovered** — including routes that exist only as
  `router.get('/x')` joined to the prefix its router is mounted at. Counting
  those halves separately gets the registry wrong in both directions.
- **61 of 66 routes had no auth gate**, several of them destructive, behind a
  public TLS ingress.
- The project's own auth helper was written, exported and documented — and
  referenced **exactly once, inside its own doc comment.** Zero call sites.
- A private key in the working tree **and in git history**, so deleting the file
  would not have un-leaked it.
- Grade **F**.

*(The findings are summarised without naming the codebase or its routes. They
belong to that team, and a public repository is not where another project's
unpatched exposure gets listed.)*

It also caught VibeUbi lying about itself: the Express adapter returned
`{external: true, carriesArtifactId: true}` unconditionally while putting
"NOT WIRED" in the human-readable field, so `plan` printed a green tick next to
the words NOT WIRED. Fixed — the claim now describes what the adapter can
actually do, and `plan` refuses.

### And the scan failed its own precision rule first

The secret-in-logs rule initially matched the *word* "token" or "secret"
anywhere in a `console.log`. Nine hits on the real project; one was real. About
**11% precision**.

`textRuleFitness` in the kernel refuses to let a rule under 90% gate anything,
and `baselineAdmission` refuses to absorb the noise. So the rule was rewritten
with a lexer, not excused — and `token`/`tokens` were deliberately dropped from
the credential-name list, because in that codebase they are a *unit of
measurement*. That costs one real finding and removes nine false ones: a hole
instead of a statement somebody signs for as real debt.
