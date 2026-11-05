# `ubi init` — what it works out, and what it refuses to

```bash
ubi init --dry-run          # probe and print; write nothing
ubi init                    # probe and write vibeubi.config.mjs
ubi init --force            # overwrite an existing config
```

Three kinds of answer, kept apart on purpose:

| | |
|---|---|
| **FOUND** | read off the disk. Safe to write in. |
| **GUESSED** | inferred from a convention, and **labelled in the config**. Safe to be wrong: the first `ubi orphans` shows it immediately. |
| **REFUSED** | `proof`. Never invented. |

## What it reads

| | from |
|---|---|
| framework | `package.json` deps (`next`, `express`), `manage.py`, `pyproject.toml` |
| entry file | the first of `server/index.js`, `src/server.js`, `app.js`, … that exists |
| routes / pages dir | convention — **marked GUESSED** |
| port | `PORT \|\| 3000` or `listen(3000)` in the entry |
| build / start / test | `package.json` scripts |
| test runner | deps **and** the test script — a project can invoke a runner it does not list, and the script is what actually runs |
| deploy shape | `k8s/` > compose > `Dockerfile` > filesystem-swap |
| **auth helpers** | your own source. See below. |

## Auth helpers: the interesting part

Nothing can guess what your auth helper is called, and guessing is how a
scanner reports every route as ungated. So `init` reads your source and counts
**declarations and call sites separately**:

```
✓ auth          ×11 call site(s)
! verifyToken   — declared here and called by NOTHING.
                  A control that was built and never wired.
```

Two rules make that line trustworthy:

1. **A declaration is not a use.** Without subtracting it,
   `export function verifyToken(…)` counts as one use and an unwired control
   reads as wired.
2. **A doc comment is not a call site.** The source is lexed first. The real
   case that forced this: a helper whose only appearance outside its own
   declaration was `* Usage: router.get('/protected', verifyToken, …)` — in the
   comment explaining how to use it. Counting that made a completely unwired
   auth control look wired.

On a real project this line found a publicly-reachable API with no
authentication **before any scan ran at all.**

## `proof` is always REFUSED

`init` writes the field commented out, with the reason, every time.

It is the only field where a wrong answer produces **no error anywhere else** —
every other mistake shows up as a red cell; a bad proof just quietly makes the
gate meaningless. Two rules, neither negotiable:

1. the evidence is fetched from **outside** the deployed process
2. the evidence can **contain the artifact id**

If a `/health` or `/version` route exists, `init` offers it as a *candidate* and
says what to check:

```
proof REFUSED
  · there is a /health route — check whether it returns the COMMIT or just "ok".
    Only the former can prove a deploy.
```

## After init

```bash
ubi orphans     # everything discovered that nobody has claimed
ubi scan        # S0–S4 against what you just wired
ubi viz         # the diagram IR
```

## Not implemented yet

`add`, `intent`, `why` and a stand-alone `verify` are described in the skills
and in `docs/COMMANDS.md` as the intended flow, and the kernel decisions they
need are built and tested — but those CLI subcommands are not written
(verification is a phase of `ship`; `diagnose` runs its steps without stopping at
the first red). `adopt`, `ship` and `rollback` ARE implemented. The working set
today is:

```
init · orphans · adopt · plan · scan · roster · viz · find · probe
checklist · deliver · status · ship · diagnose · rollback · guard · help
```
