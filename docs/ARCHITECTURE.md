# Architecture

## The problem, stated precisely

Coverage is a **memory artefact**. People do not remember "everything that
exists"; they remember "what they touched recently". So coverage is a function
of who happened to remember what, last week — and that function does not scale
with codebase size, while the codebase does.

Automating the *running* of tests lowers the price per run. It does not touch
the decay, because *what to test* still lives in a head.

## Ten kinds of remembering, and what removes each

The marker on each row is the function that removes it — not a sequence number.
This is a roll, not a process: order carries nothing, absence carries
everything.

| you would have to remember | what removes it | the shape of the failure |
|---|---|---|
| this feature exists | `orphanVerdict` | new feature ships, zero tests, nothing says so |
| to run the check | the pipeline **is** the deploy path | works exactly as long as somebody remembers |
| this test is wired into a suite | test-file coverage baseline | measured once: 941 test files, 214 called by nothing |
| green ≠ verified | `testRanVerdict` | `# pass 0` + exit 0 · a suite dying at file 44 · exit 2 with zero output read as "0 problems" |
| the deploy took effect | `deployProof` | restart returned 0; the swap did not happen; every other signal said success |
| the tree has not drifted | `treeDrift` | someone saved a file while verify was running; the only guard was somebody happening to notice |
| config reached the process that reads it | `envParity` | five tenants "isolated"; at runtime all resolved to one bucket; every gate green |
| why that layer was skipped | `--without-reason` | in six months the row must say *why* nobody looked |
| to clean up what the test created in production | `reapDecision` | fails closed on four conditions; a cleanup that could not run is a red cell naming the object |
| whether this red is even yours | `attributedVerdict` | one release reverted by a cell that ran 124s / 7s / 28s on the restored build |
| to give a new step a time budget | `budgetVerdict` | a step added to the runner with no budget entry silently took the 15-minute default; the ≥6×/≤40× rule never saw it. Same gap had already bitten once |
| that a passing test can still prove nothing | `vacuousComparison` | `undefined` passed explicitly to a parameter whose default is `process.env.X` — the default fires, both sides read the same source, the assertion cannot fail |
| that a false positive is worse than a hole | `baselineAdmission` | a checker missed a third invocation shape and called two *running* test files unrun; the obvious fix would have declared, in writing, that nobody runs them |
| to keep an exemption narrow | `exemptionScope` | a correct `404` went red three ships running; two retries were filed as flake, the third rolled back a good build |
| that a check must call the thing | `checkAssertsOnBehaviour` | gate assertions compared a script's source text; upstream shrank it 187 → 29 lines and moved the capability, so the gate failed on spelling |

## Three axioms

Every row above is an instance of one of three, and they are layered:

- **A · discovery replaces memory** → governs **existence**
- **B · declaration replaces memory** → governs **meaning** (absence is an error)
- **C · evidence replaces memory** → governs **outcome**

C is the one other tools do not have. Progressive-delivery gates watch
*metrics*; VibeShip watches a feature matrix and an exposure map, and for "did
this deploy happen" demands a fact observed from outside the deployed process.

## Rings

```
┌──────────────────────────────────────────────┐
│ ADAPTERS   per stack, per deployment         │  community
│ build · swap · proof · session · discover    │
│ ┌──────────────────────────────────────────┐ │
│ │ LAYERS / RULES   L0–L6 · S0–S7           │ │  extensible
│ │ ┌──────────────────────────────────────┐ │ │
│ │ │ KERNEL   pure, zero I/O, 46 tests    │ │ │  the product
│ │ │ verdictFor · deployProof             │ │ │  read-only to agents
│ │ │ testRanVerdict · attributedVerdict   │ │ │
│ │ │ prereqVerdict · reapDecision         │ │ │
│ │ │ orphanVerdict · rosterVerdict        │ │ │
│ │ └──────────────────────────────────────┘ │ │
│ └──────────────────────────────────────────┘ │
└──────────────────────────────────────────────┘
```

**Plugins supply capability; the kernel judges.** The kernel has no plugin
hooks at all. That is what makes it safe to let an agent write plugins freely.

## Statuses, coloured by whether they gate

| status | gates? | why |
|---|---|---|
| `fail` @ P0 | **yes** | |
| `error` | **yes** at any priority | a layer that could not answer has not cleared the deploy |
| `fail` @ P1/P2 | no | a gate nobody can get through ends with builds run by hand |
| `blocked` | no — **but always said** | rollback cannot reach a dependency that is down; shipping in silence over an outage teaches people the layer is decorative |
| `skip` | no — **must carry a reason** | |
| `pass` | no | |

A colour scheme that groups `error` with `fail@P0`, and `blocked` with
`fail@P1`, is telling the truth about consequences rather than about how
alarming a word sounds.

## Judging early is provably safe

`ship` swaps before it sweeps, because the sweep runs against the live site.
That window is the pipeline's worst property, so cells that *can* block run
first and are judged as they arrive.

This is sound because `verdictFor` **filters** for a blocking cell rather than
counting. Adding cells can therefore only add blockers, so a refusal on a
subset is a refusal on the whole — same decision, minutes earlier. A property
test covers every combination of status × priority, because if that function
ever starts counting, early judging silently becomes unsound.

## The AI-driven split

```
1 WIRE   probe, write the adapter, list orphans     ← agent (one human confirm: proof)
2 ADOPT  turn orphans into declarations             ← agent
3 SHIP   the pipeline                               ← deterministic, zero LLM
```

> **An agent may widen what gets checked. It may not move the pass mark.**

Because the model that wrote the code is the model that would review it, and
the blind spots are correlated. And because an agent has a *cheaper* move than
fixing a failure: making the check go away. `ignored`, `publicApi`,
`--without`, `accept-debt`, unpinning a tool, lowering a P0 — six legal
silencers, all of them human-only, enforced by `requiresHuman()`.

`intent` is free text an agent reads and **the gate never does**. Vague intent
can only produce worse probes — visible and fixable. Free text in the judging
path would be unfixable.


## Credits

Ten of the fourteen rows above came out of one deployment pipeline over two
weeks. The last five were contributed on 2026-09-13 by the session that runs
that pipeline daily — each one a defect it hit, diagnosed, and fixed,
generalised here into a pure function with a test.

That is the intended shape of this project: **a rule earns its place by having
cost someone a real afternoon**, and arrives with the incident attached.
