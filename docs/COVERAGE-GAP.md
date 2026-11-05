# Coverage gap from commits

`vibeubi coverage-gap` reads the commits that arrived since a base (typically the
commit that is live) and answers one question: **which of the things these commits
added or changed does no acceptance item actually exercise?** It prints that list,
a draft acceptance script per gap, and (optionally) exits non-zero so a merge or a
release stops until a human has looked.

It exists because a teammate who does not use vibeubi writes no acceptance items.
After merging their commits the gate stays green, because every changed file is
*claimed* by some wide glob (`components/**`) even though nothing drives the new
screen. "Claimed by a glob" and "watched by a test" are different facts.

## What it measures

Input: `git diff base head` (the committed net change, never the working tree) and
`git log base..head` (who wrote it; merges are expanded because the range walks
every commit, a merge commit is listed with `isMerge` and owns no files).

Each changed, non-deleted file is classified (`route | page | component | api | lib |
test | config | docs | other`, pluggable) and put in one of three states:

| state | meaning | gap kind |
|---|---|---|
| exempt | class is in `exemptClasses` (default `docs`, `test`, `config`) or an `ignored` glob matches | none |
| unclaimed | no claim glob (`covers` / `selfPaths` / delivery feature) matches it | `unclaimed` |
| claimed, new surface | the file is **new** (or its added lines introduce a new `data-testid`, exported component, HTTP method handler) in class route/page/component/api, **and** nothing exercises that surface | `new-surface` |
| claimed otherwise | covered | none |

A new surface is **exercised** when either

1. a *specific* claim matches the file. A claim glob is specific when it matches at
   most `broadThreshold` (default 25) tracked files. `components/**` is not.
2. some evidence file (`evidence` globs, e.g. `scripts/acceptance/**`) *mentions* one
   of the surface's tokens: a new `data-testid`, the route path, an exported
   component name, or the file's basename.

A wide glob that merely contains the file does not count. That is the whole point.

## Whose gap is it

Commits are attributed to authors; `ownAuthors` (patterns on `Name <email>`, `*`
wildcards, or a `RegExp` in a JS config) says which are ours. A gap touched by any
commit not ours is `foreign` and has severity `red`; otherwise `warn`. Unknown
authorship counts as foreign. `--authors-not <pattern>` overrides `ownAuthors` and
reports only the foreign gaps.

## Drafts

`draftFor(gap, templates)` returns a `record()` skeleton for each gap with selector
suggestions pulled from the changed file (`data-testid`, `aria-label`, route path,
HTTP methods, `/api/...` calls, exported components), the commits that caused it, a
suggested `covers`, and `after`. The template is project-owned text with `{{name}}`
placeholders (unknown placeholders throw, so a typo is loud). `--drafts-dir DIR`
writes one file per gap.

## Gating and acknowledgement

```
vibeubi coverage-gap --base <ref> [--head <ref>] [--format json|md]
                     [--fail-on-uncovered [foreign|all]] [--authors-not <pattern>]
                     [--drafts-dir DIR] [--tree <ref|worktree>]
vibeubi coverage-gap --base <ref> --ack --by <name> [--note <text>]
```

Exit codes: `0` nothing blocks, `1` blocking gaps (and no valid ack), `2` bad usage
or config, `3` unexpected error.

Without `--fail-on-uncovered` the command only reports. With it, any unacknowledged
gap in scope blocks (`foreign` limits the scope to red ones).

A **human** acknowledges a list with `--ack`: `.vibeubi/coverage-ack.json` records
the sha256 of the gap list (`kind`, path, the file's blob id at `head`, author
bucket), who, when and why. The ack is valid only while the list is byte-identical:
a new gap, a gap that disappeared, or any edit to a gapped file expires it, and the
report says what changed. `coverage-ack` is in `NARROWING_ACTIONS`, so `vibeubi guard
--action coverage-ack` tells an agent hook to refuse: acknowledging a gap makes a red
light go away without writing the test.

## Limits

- Text matching is a heuristic. A script that mentions `status-band` in a comment
  satisfies the mention test. Choose `evidence` globs that contain only scripts that
  drive the product.
- Dynamic `data-testid={`row-${id}`}` is not extracted; the file basename is still a token.
- Renames use git's rename detection; a pure rename produces no added lines and so
  no new-surface gap.
- Conflict-resolution content that exists only in a merge commit is attributed to
  no commit (the file counts as foreign if it has no author at all).
- `--head` may be a remote ref; claims, `ownAuthors` and `evidence` come from the
  checkout (config) and from `--tree` (default `head`).
