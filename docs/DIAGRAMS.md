# Diagrams — a picture that can be checked

Diagram skills normally ask an agent to read a codebase and emit an IR. The
agent guesses, and the picture is exactly as right as the guess.

**VibeUbi does not guess.** Its registry was discovered mechanically and
declared explicitly, and every node carries a verdict from a real run. So each
box traces back to the file it was found in and the cell that judged it.

```bash
vibeubi viz --format ir       > coverage.ir.json       # neutral
vibeubi viz --format archify  > coverage.archify.json  # archify's schema
vibeubi viz --format mermaid  > coverage.mmd           # zero-dependency
```

## With archify (or any other diagram skill)

```
1. vibeubi viz --format archify > coverage.archify.json
2. hand that file to the archify skill as the IR — it compiles, you do not
3. put the provenance sentence in the caption
```

The neutral IR is deliberately **not** archify-shaped, so another tool can
consume it. Supporting one more is a projection function (`toArchify` is 18
lines), not an integration.

## Every node carries provenance

```json
{
  "id": "page:/settings/billing",
  "tone": "danger",
  "provenance": { "discoveredIn": "app/settings/billing/page.tsx", "declaredIn": "vibeubi.config.mjs" },
  "coverage": [{ "layer": "L2", "status": "pass" }, { "layer": "L3", "status": "fail", "reason": "…" }]
}
```

## Three pictures worth drawing

| picture | answers | source |
|---|---|---|
| **coverage** | which areas are checked at which layers | `nodes[].coverage` |
| **exposure** | who can reach what, and whether auth is required | `edges` (from S4) |
| **cost** | which features eat the wall-clock | cell `ms` |

## Colour by consequence

`fail@P0` and `error` share a colour because both roll back. `blocked` and
`fail@P1` share another because neither does. A legend that says something true
beats a pretty gradient.

## The caption is not optional

> Nodes were discovered from the source tree and declared in the registry.
> Colours are verdicts from run `<id>` at `<timestamp>`. Nothing here was
> inferred by a model.

That sentence is the entire difference between this and a generated diagram.

## The console

The browser console that produced these screenshots is a demo and ships separately
fill in live — the same IR, rendered as an instrument rather than a document.
It has a deliberate second button, **"Run with a planted regression"**, because
*a gate you have never seen refuse is a gate you do not know works.*

## The console

The interactive console that produced the screenshots in this document is a
DEMO built from one project's recorded run, so it lives outside this repository
— see "What belongs here" in the README. What ships here is the IR and the
exporters: `vibeubi viz --format ir|archify|mermaid` gives any diagramming tool
the same structure the gate judges, so the picture and the verdict cannot
disagree.


## DOM verification

The console is checked in a real browser, not by eye. What is asserted:

| | |
|---|---|
| at rest | 22 nodes, verdict banner hidden, log seeded |
| refused replay | rail ends `verify:pass build:pass swap:pass prove:pass sweep:fail gate:fail report:pass` |
| shipped replay | all seven `pass`, verdict `clean` |
| expand | clicking an area goes 22 → 47 nodes, inspector lists 25 routes |
| filter | `ungated` dims exactly the gated areas |
| zoom / reset | transform changes, reset returns `translate(0 0) scale(1)` |
| theme | toggle stamps `data-theme` and the body background actually changes |
| tokens | every colour token resolves — none empty |
| **labels** | **measured with `getBBox()`**: zero overlaps between an area name and its count |
| console | zero messages |
| layout | `document.compatMode === "CSS1Compat"`, no horizontal scroll |

Three real defects came out of doing this rather than looking at it:

1. **A tick appeared on a step that failed.** The summary line
   `ROLLED BACK  1 P0 failure(s)` matched the same pattern as the failure line
   before it — but without the `✗` — so it reset sweep and gate to `pass`, and
   a rolled-back run ended showing green. Step verdicts are now **monotonic**:
   once failed, nothing later may turn it into a tick. Same shape as
   `verdictFor` filtering rather than counting.
2. **`verify` never resolved.** Its completion test looked for the word
   "verify" in a line that does not contain it (`✓ all 2 layer(s) can run`).
   It sat on `run` forever and nobody noticed by looking.
3. **Overlapping text.** `claude-remote` ran straight through `10/10 open`.
   Labels are now truncated to what actually fits beside the count. In a
   picture whose entire claim is that it can be checked, two strings on top of
   each other is not a style nit.

Also: the page is authored without a doctype so it can be published as an
artifact (the host supplies one). Served raw, the browser fell into quirks mode
— a demo would have discovered live that the local copy lays out differently
from the published one. `server.mjs` now prepends it.

### The full DOM checklist

43 assertions, run in a real browser against the local server. Not a smoke
test — the list is the spec.

| group | asserted |
|---|---|
| structure | title · doctype + standards mode · 7 rail steps · inline favicon · 4 legend entries |
| data | embedded JSON parses · route count matches the meta · both runs present · **every** route carries a state · **every** finding carries a rule and a reason |
| at rest | verdict hidden · 23 nodes · zero label overlaps |
| blocked replay | rail ends `sweep:fail gate:fail` · verdict `refused` · zero overlaps |
| shipped replay | all seven `pass` · verdict `clean` · says "fixed, not waived" · zero overlaps |
| inspector · chain | why-line present · explains mount-level guarding |
| inspector · area | why-line · priority tally · 25 route rows · every row carries a P badge and a state dot · expanding adds nodes |
| inspector · route | why-line · names the source file · **shows whether the priority came from `declared` or `severity`** · says whether it gates |
| filters | all / blocks / flagged toggle correctly · `all` dims nothing |
| zoom | in and out both change the transform · reset returns `translate(0 0) scale(1)` and clears the inspector |
| theme | toggles both directions · body background actually changes · **no token resolves empty in either theme** |
| a11y | nodes are `tabindex=0`, have `role=button` and an `aria-label` · Enter opens the inspector · every button has accessible text |
| layout | no horizontal scroll · the graph scrolls inside its own box |
| console | **zero messages** |
| live server | `/api/where` reports live · `/api/run` streams the real CLI · exit 0 · the page does not monkey-patch `fetch` |
| reduced motion | emulated for real, not just grepped: renders · replay completes in <6s · rail reaches a terminal state · **nothing stuck part-way faded or mid-translate** · glyph corners settle to `miter` · expanding still works and the new nodes are visible |

Overlap detection compares glyph bounding boxes **sorted by x**, not by DOM
order. The first version assumed the label was drawn first; when the draw order
changed it reported 19 overlaps that did not exist. A checker with an assumption
about the thing it checks is the thing it is supposed to catch.

### Timing is a claim, so it gets measured

A reader looked at the console and said they could not see any difference.
They were right, and the fix came from measuring rather than guessing.

Instrumented in the browser: `BROKEN` was on screen for **2,131 ms of a
5,369 ms replay** — and for most of that the reader's eye is on the log. Look a
second late and the panel is already back to the good build, so the demo
silently shows nothing.

Three changes, each verified:

| | |
|---|---|
| **hold it** | lines inside the broken window now pace at 850ms instead of 150ms. Measured again: **7,250 ms**, asserted `>= 5000`. |
| **flash it** | the panel border pulses red going into the broken build and green coming out, so the eye is taken there. `prefers-reduced-motion` gets a static outline instead. |
| **let them do it** | a `broken` / `good` toggle in the panel header. The timed replay is a story; a toggle is a comparison, and a comparison does not depend on looking at the right moment. |

The pixel check matters more than it sounds: comparing `img.src` only proves a
string changed. The test rasterises both to a canvas and sums the channels —
a delta of **69,887** is the two builds actually differing, not a data URI
being swapped for another name for the same picture.
