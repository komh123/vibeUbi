---
name: vibeship-adopt
description: Wire a project into VibeShip, or claim orphan features after adding new code. Use when a VibeShip run reports orphans, when the user adds a page/route/view/command/tool, when setting up VibeShip on a new repo, or when the user says "adopt", "claim", "declare", or "wire up". Runs the two AI-executed steps of the three-step flow.
---

# Adopt — the two steps an agent does for itself

Three steps get a project gated. You do steps 1 and 2. Step 3 is machinery.

```
1 WIRE   probe the project, write the adapter, list every orphan     ← you
2 ADOPT  turn each orphan into a declaration                          ← you
3 SHIP   verify → build → swap → prove → sweep → gate → report        ← deterministic
```

## Step 1 · WIRE (once per project)

```bash
npx vibeship init          # probes and writes a vibeship.config.mjs draft
```

Work out and fill in: framework, where routes live, what roles exist, how to
mint a session for each, how the project builds, how it swaps, what listens on
a port.

**One field you must not decide alone: `proof`.**

`proof` answers "did the thing we just deployed actually start serving?" Two
rules, neither negotiable:

1. The evidence is fetched from **outside** the deployed process.
2. The evidence can **contain the artifact id**.

| stack | a proof that works | a proof that does not |
|---|---|---|
| Next.js | `BUILD_ID` in the served page's asset paths | the build's exit code |
| any HTTP service | `/version` echoing the git sha | HTTP 200 from `/health` |
| Kubernetes | in-pod file hash **+ pod age** | `kubectl rollout status` exit 0 |
| container | the running container's image digest | `docker compose up` exit 0 |

Every entry in the right column is the exit code of the thing that did the
deploying. That is the class of evidence this gate exists to refuse.

Write your proposal, run `npx vibeship init --confirm-proof`, and **let the
human confirm it.** It is the only field where a wrong answer produces no error
anywhere — the gate simply stops meaning anything.

## Step 2 · ADOPT (every time features are added)

```bash
npx vibeship orphans       # discovered but nobody claimed them
npx vibeship adopt         # write declarations for all of them
npx vibeship adopt --only area=billing
```

For each orphan, fill in:

| field | how to decide |
|---|---|
| `area` | the product noun a user would use, not the folder name |
| `requiredRole` | the *lowest* role that should see it. Guess low and let the gate correct you — a guest reaching a protected page is a leak the gate will catch loudly. |
| `priority` | P0 = money, auth, data loss, or the main path. P1 = a real user flow. P2 = everything else. |
| `testId` | must already exist in the source. Add it to the component if it does not. |
| `probes` | required for P0. See below. |
| `journey` | required if the feature has a **create** path. Read-only layers never walk one. |
| `intent` | free text. See "the intent field" below. |

### Writing probes from intent

Read the `intent` text and translate behaviour into probes. The distinction
that matters most:

```js
// intent: "with no subscription the save button must be DISABLED, not hidden"
probes: [
  { expectVisible: "app-billing-save" },
  { expectDisabled: "app-billing-save" },   // ← not expectHidden
]
```

`expectHidden` and `expectDisabled` are not interchangeable. A destructive
control that is *present and refusing* is a different safety property from one
that is absent, and `expectVisible` is blind to the difference.

Use `{ invariant: { computedStyle: "<testId>" } }` when the intent says
something must **not change**, and `{ wait: <ms> }` before an invariant when
the risk is something the app does to itself once the user stops touching it.

### The intent field — a hard rule

`intent` is read **by you**. It is **never read by the gate.** The gate only
reads structured fields (`priority`, `requiredRole`, `probes`, `expect`).

So a vague or stale intent cannot skew a verdict — it can only make your next
`adopt` produce worse probes, which is visible and fixable. Never move free
text into the judging path.

## What you must not do here

If `adopt` cannot produce a sensible declaration for something, **say so.**
Do not route it into `ignored` to make the orphan check green. `ignored`,
`publicApi`, `--without`, `accept-debt`, unpinning a tool, and lowering a P0
are all *narrowing* actions, and every one of them makes a red light vanish
without fixing anything. They require a human and a written reason.

## Adding a feature end to end

```bash
npx vibeship add page /settings/billing \
  --intent "org admins only; with no subscription the save button is disabled, not hidden"
```

That single command should leave behind: the file, the declaration, probes
derived from the intent, a journey if it writes, and the new test file wired
into a suite (an unwired test file is a test that does not exist — `vibeship
verify` will say so by name).
