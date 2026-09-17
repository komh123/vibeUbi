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

| verdict | judged as |
| --- | --- |
| `PASS` | pass |
| `PASS_WITH_NOISE` | **fail** by default — see below |
| `FAIL` | fail |
| `BLOCKED` | error — "we do not know" is not a pass |
| `NOT_EXERCISED` | error — same |
| anything else | error — an unknown verdict is not a pass |

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
`PASS (with noise)` at the top level.

The two halves disagree. This follows the stricter one, and `noiseIsFailure`
exists so a project can differ **on purpose** rather than by inheriting
whichever half it happened to read.

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
