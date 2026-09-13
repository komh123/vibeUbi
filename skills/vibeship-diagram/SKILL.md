---
name: vibeship-diagram
description: Turn a VibeShip run into a verifiable architecture diagram, using archify or any other diagram skill. Use when the user asks to visualise a project's coverage, draw the architecture, see the attack surface as a picture, or asks "what does this project look like from the gate's point of view".
---

# Diagram — a picture that can be checked

Diagram skills normally work by asking an agent to read a codebase and emit an
IR. The agent guesses, and the picture is exactly as right as the guess.

**VibeShip does not guess.** Its registry was discovered mechanically and
declared explicitly, and every node already carries a verdict from a real run.
So every box traces back to the file it was found in and the cell that judged
it. The picture is *evidence*, not an illustration.

## Producing the IR

```bash
npx vibeship viz --format ir       > coverage.ir.json      # neutral
npx vibeship viz --format archify  > coverage.archify.json # archify's schema
npx vibeship viz --format mermaid  > coverage.mmd          # zero-dependency
```

## Handing it to archify (or anything else)

```
1. npx vibeship viz --format archify > coverage.archify.json
2. invoke the archify skill with that file as the IR — it compiles, you do not
3. state in the caption that nodes are discovered, not inferred
```

The neutral IR (`--format ir`) is deliberately not archify-shaped, so a
different diagram skill can consume it. Adding support for one is a projection
function, not an integration.

## Three pictures worth drawing

| picture | what it answers | source |
|---|---|---|
| **coverage** | which areas are checked at which layers | `groups[].nodes[].coverage` |
| **exposure** | who can reach what, and whether auth is required | `edges` (from S4) |
| **cost** | which features eat the wall-clock | cell `ms`, same shape |

Colour by whether something **gates**, not by how alarming the word sounds:
`fail@P0` and `error` share a colour because both roll back; `blocked` and
`fail@P1` share another because neither does. That encoding is true, and a
legend that says something true is worth more than a pretty gradient.

## Say this in the caption

> Nodes were discovered from the source tree and declared in the registry.
> Colours are verdicts from run `<id>` at `<timestamp>`. Nothing here was
> inferred by a model.

That sentence is the entire difference between this and a generated diagram,
so do not leave it off.
