# The probe step — plugging a skill into the pipeline

```
verify → build → swap → prove → sweep → gate → probe → report
                                                 ↑
                                          a SKILL runs here
```

## What it is

vibeUbi writes an **order**; an agent runs whatever **skill** is configured;
vibeUbi judges the **result**. The pipeline never drives a browser, and the
skill never decides whether the deploy ships.

```
        order.json                     result.json
vibeUbi ──────────▶ agent + skill ──────────────▶ vibeUbi
  what to check      how to check it              did it hold
```

That split is this product's one rule in a different place: **an agent may
widen what gets checked; it may not move the pass mark.**

## Why the skill is not called by the pipeline

`dom-test`'s first rule is that input must be real. Measured on one element of
a live app: synthetic input fired **3 events, all `isTrusted: false`**; real
CDP input fired **11, all true** — five of the eight types never fired at all.
A click-vs-drag bug lives in whether `pointerup` pairs with `pointerdown`, so
the synthetic path cannot detect it *even while testing it*.

Driving that well needs judgement: which invariants matter for this page,
whether a red channel is the app or the fixture, whether a locator went stale
or the app broke. That is agent work. Having the pipeline fake it would produce
a worse test and a false green.

## Why it runs AFTER the gate

It is the expensive step — a real browser over N pages. There is no reason to
pay for it on a deploy that already failed for a cheaper reason.

## Why it can still roll back

`probe` is `mutates: true`. A P0 red here rolls back for the same reason a P0
red in the gate does: undoing the deploy undoes the problem. A step that could
find a broken login page and then ship it anyway would be a report, not a gate.

## Configuring it

```js
probe: {
  skill: "dom-test",       // or false to turn the step off
  only:  ["P0"],           // which declared priorities to order
  noiseIsFailure: true,    // see below
  fulfil: async (order) => result,   // optional: supply the result directly
}
```

Without `fulfil`, the step writes `probe-order.json` into the run directory and
reads `probe-result.json` back from it.

## The order

Derived from the registry, never from anyone's memory. Pages only — an API
route has no DOM — filtered to the declared priorities, ordered by priority so
that if the expensive step is cut short it is cut at the least important end.

Every item carries the **free invariants**: the whole-page relations from
`dom-test/invariants.md` that need nobody to author them.

| relation | what a person would have noticed |
| --- | --- |
| no new console errors | the red flash; a hydration mismatch repainting differently |
| no unprompted layout shifts | the page jumping while you read it |
| no sideways scroll at 390px | 爆版 |
| contrast ≥ 4.5 in **both** themes | white-on-white after a theme switch |
| `reload(x) ≡ x` | the rename that showed the new name until F5 |

They matter because a step that is worthless until somebody does a week of
authoring is a step nobody turns on.

## The result, and every way it can look complete without being

```json
{ "skill": "dom-test", "artifactId": "<the id this deploy is proving>",
  "observed": [ { "id": "page:/login", "verdict": "PASS", "why": "...", "evidence": {} } ] }
```

| verdict | judged as | rolls back? |
| --- | --- | --- |
| `PASS` | pass | no |
| `PASS_WITH_NOISE` | pass, recorded as its own state | no by default — see below |
| `FAIL` | fail | **yes** |
| `BLOCKED` | blocked — unverified, counted | no |
| `NOT_EXERCISED` | blocked — same | no |
| anything else | blocked — an unknown verdict is not a pass | no |
| (item missing from the result) | blocked — unverified, counted | no |

### After the swap, absence of evidence must not undo a good deploy

The first version rolled back on all of those. A peer's **first real run** hit
it: a page came back `BLOCKED` because the pipeline's own sweep had rotated the
test account's password. The deploy was fine, and the step replaced it with the
previous build because of a fixture.

Their distinction is the one this now runs on:

> **"I could not see it" costs a different amount before and after the swap.**
> Refusing at `verify` costs "this does not ship today", which is free. Rolling
> back at `probe` is an ACTION — swapping a good build out on the strength of a
> measurement that did not happen.

So only `FAIL` — positive evidence that something IS broken — rolls back.
Everything merely missing is `blocked`: not a pass, not a rollback, **counted**.

`verdictFor` already had exactly this state, with a comment that already said
it: *"a dependency is unavailable — not caused by this deploy, and rollback
cannot fix it."*

### …but the step takes its own look first

Making absence non-blocking fixed a false red and opened a worse hole, and a
peer named it before it bit anyone:

> A deploy that takes the site down makes the skill honestly report *"I could
> not load the page"* — the **same word** as an expired test password, and the
> two need opposite handling.

The discriminator is not in the reason text. A rule that reads a
caller-supplied reason is one an agent satisfies by writing better prose, and an
enum is only structured prose unless something can **contradict** it. So
vibeUbi takes its own look at `base` before judging — one HTTP request,
trusting nobody, the same move as `deployProof`:

| what vibeUbi sees | what the skill said | judged |
| --- | --- | --- |
| base 2xx | "could not see it" | the deploy is alive, the test side is not → **blocked**, ships |
| base 5xx / unreachable | "could not see it" | it is the deploy → **FAIL**, rolls back |
| base 5xx / unreachable | nothing reported | consistent → **FAIL** |
| no look taken | anything | **named**, never assumed alive |

`prove` saw this artifact serving minutes earlier, so a base that is down at
probe time is a regression, not a fixture.

The protection against this becoming decoration is that the number is printed,
in the outcome and not only on screen:

```
shipped · no failures · 1 P0 page(s) could not be verified
```

A caller running the step BEFORE a swap — where refusing is free again — sets
`unmeasuredBlocks: true`.

And the rules that are not about any single verdict:

- **Ordered and not reported is not a pass.** A result with three green rows
  for a twelve-item order has told you nothing about nine of them. `dom-test`
  says this about itself — *"a short green list must never read as full
  coverage"* — and it is the same sentence as this pipeline's coverage rule.
- **The result must name the artifact it was produced against.** A result file
  is a REPORT, which is the class of evidence this product refuses. Without
  that check yesterday's green file passes today's ship.
- **The result must name the skill that was ordered.** A swapped slot quietly
  answering a different question is the hole a pluggable step would otherwise
  open.
- **Volunteered items are kept.** Anything the skill checked without being
  asked is recorded as a cell — that is the agent widening the check, which is
  the half it may do.

### `PASS_WITH_NOISE`, and a disagreement inside the skill

`dom-test`'s acceptance-checklist table says a channel going red on an item
whose condition held *"is still a FAIL of that item; that is precisely what the
manual tester would have noticed."* Its `scenario.js` is looser and reports
`PASS (with noise)` at the top level. **The two halves disagree.**

This defaulted to the stricter half, chosen with no data. Then a peer measured:
on their app roughly **one run in four** produces `net::ERR_NETWORK_CHANGED`
from an SSE stream cut by navigation — noise nobody can act on. Strict by
default would therefore have rolled back a good deploy about every fourth
deploy.

So the default is now loose, and `PASS_WITH_NOISE` is still recorded as its own
state rather than flattened into a pass. `noiseIsFailure: true` is there for a
project that wants it.

The real fix is not this knob. **The skill needs to separate actionable red
from transport noise**, and until it does, `noiseIsFailure: true` turns a
skill's ambiguity into a deploy decision.

## Trying it on a repo that has not adopted vibeUbi

Trying one step should not require making the adoption decision first:

```bash
vibeubi probe --declared ./pages.json --base https://app.test --artifact <id>
vibeubi probe --judge --declared ./pages.json --base https://app.test --artifact <id>
```

`pages.json` is just a list of `{ id, priority, testId?, probes? }`.

## Where the artifact id comes from — and why copying it is not enough

The result carries **two** ids and only one of them is evidence:

```json
{ "artifactId": "<copied from the order>",
  "observedArtifact": "<READ off the running site>" }
```

`artifactId` is the claim. Copy it from the order — that part is free.

`observedArtifact` is what the skill actually read from the deployed app while
testing it, and it is the one that matters. This documentation used to
recommend only the copy, and a peer measured what that check is worth:

> The result's id is copied from the order, so the two are **equal by
> construction** and the comparison cannot fail. It catches yesterday's FILE.
> It misses today's file about yesterday's BUILD.

That second case is not hypothetical — it is precisely what a run before the
swap produces, since the site is still serving the previous artifact at that
moment. The test is real, it passes, and it is about the wrong build.

**A check whose inputs come from one source has one source, however many fields
it compares.**

Missing `observedArtifact` is not a refusal — a skill that cannot read the
artifact off the site is a real situation — but it is named, as a P0 `blocked`
cell, so a claim-vs-claim comparison never reads as if it were evidence.

vibeUbi also takes its own read at judge time. If the site is serving a
different artifact than the one being deployed, something replaced it between
`prove` and `probe`, and that is a `fail`.

## Items are independent — a fresh SESSION, not just a navigation

The order says so explicitly, in `contract.itemsAreIndependent`, because the
sequence is **not stable**: it sorts by priority then id, so editing any
declaration's `priority` can reorder it. A peer's runner logged in during one
item and the next item then found no password field — a failure produced
entirely by an unrelated registry edit.

Each item gets its own **cookies, storage and auth state**. The peer who asked
for this contract then broke it while honouring the word: their runner gave
every item its own `goto` and shared one browser context, so a login in one item
made the login page redirect away in the next and it failed to find a form.

**"Independent" read as "navigates itself". It means a fresh session.** The
natural implementation shares a context, and sharing is completely invisible
when you test one item at a time.

`dom-test` says the same in its own words — *"one scenario, one context… never
let scenario 2 depend on the state scenario 1 left behind"* — and an order that
does not repeat it is relying on the skill's author having read that line.

## `discovered: false` is a branch, not a note

An item carries `discovered: false` when it is declared and the discoverer did
not find it. The skill should answer **is it there** before **is it good**:

| the url | what it means | the finding is about |
| --- | --- | --- |
| loads, probes pass | discovery under-reported | the **scanner** |
| 404s, or fails | the declaration outlived the page | the **registry** |

Neither is a fault of this deploy, both need saying, and **only the skill can
tell them apart** — it is the one holding the url that actually opened it.

Without this, the natural thing is to ignore the flag and test normally, which
files a finding about the scanner against the page. Walked for real: a declared
page the discoverer had been made to miss returned HTTP 200 and passed its
probes → "discovery under-reported; the page is there."

## What the step costs

Measured by a peer on a real app, two P0 pages:

| | |
| --- | --- |
| writing the order | 0s |
| judging the result | 0s |
| `dom-test`, light (load + probe + errors/overflow) | **9s** |
| `dom-test`, full (5 invariants + contrast in both themes + reload) | **~2.5 min** |

**This step costs nothing; the skill's thoroughness costs everything.** That is
the knob to turn, and it is the skill's, not vibeUbi's.

### Bumping the pin while a ship is running

Don't. Editing `package.json` changes the working tree, and `swap` refuses on
tree drift between `verify` and `swap` — by design, because the tree IS the
deployment and a proof taken before the edit was about a different tree. A peer
lost forty minutes to exactly this. **Let the ship finish, then bump.**

### `unmeasuredBlocks` has no correct use inside ship

The obvious idea — run the step strictly before the swap, loosely after — is
wrong, and the peer who proposed it retracted it after asking the right
question: *what is `base` pointing at in that moment?* Before the swap the site
is still serving the **previous** artifact, so a strict pre-swap pass judges the
build you are replacing. It needs a staging instance to mean anything.

## Using a different skill

Nothing in the step knows what a browser is. A security skill, an a11y skill, a
performance skill: same order, same result shape, same judging. Set
`probe.skill` and make the skill write a result naming itself and the artifact.

The contract is small on purpose — but it is a contract, not a convention:
a skill that does not honour it is refused rather than believed.

## No browser on this machine

Already handled, and by an older decision. `prereqVerdict` exists because *"a
browser layer with no browser answers `error`; the gate treats an error as
blocking"* and *"a missing browser must not be able to manufacture an
incident."* Declare the layer degraded with a reason, or turn the step off with
`probe.skill: false` — both are visible, neither is silent.
