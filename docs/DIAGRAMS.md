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

`apps/console/index.html` is a browser UI that triggers a run and watches it
fill in live — the same IR, rendered as an instrument rather than a document.
It has a deliberate second button, **"Run with a planted regression"**, because
*a gate you have never seen refuse is a gate you do not know works.*

## The console

`apps/console/index.html` is the interactive half of all this. Two ways to open it:

```bash
# static — replays the recorded run that ships with the repo
open apps/console/index.html

# live — the Run button spawns the real CLI and streams it back
node apps/console/server.mjs --root ../system-monitor --config examples/system-monitor.config.mjs
```

What you can do with it:

| | |
|---|---|
| **drag / wheel** | pan and zoom the graph |
| **click an area** | expand it into its routes, springing out one at a time |
| **click a route** | the inspector names the file it was discovered in and every finding on it |
| **hover** | lights the edge from the entry point to that node |
| **filter chips** | all · ungated · has findings |
| **Run the gate** | the 18 areas are judged one at a time and coloured **as each verdict lands** — not in a batch at the end, because that is how the pipeline actually behaves |

### Two rules the server obeys

1. **It binds to `127.0.0.1`.** Put it on `0.0.0.0` and it stops being a console
   and starts being an S4 finding.
2. **It can start `ubi` and nothing else** — a fixed map of four commands, not a
   filter over a string the page sent. A console that can be talked into running
   an arbitrary command is a remote shell with a nice font.

### Motion

Everything moves on one interruptible spring integrator. Status glyphs are two
polylines of three points on a 24×24 grid, so any glyph morphs into any other;
joins go round while moving and back to **miter at rest**, so corners stay sharp
when nothing is happening. Log lines arrive with weight — a spring settle, not a
fade. `prefers-reduced-motion` turns all of it off and the page still works.
