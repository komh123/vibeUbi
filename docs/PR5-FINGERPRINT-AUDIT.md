# PR #5 fingerprint byte contract and compatibility audit

This audit concerns fingerprint encoding and evidence compatibility only. It
does not change kernel verdicts, admission policy, deployment adapters or CI.

## Anchors and scope

- Before PR #5: `693311bfca7e6c4bcd0c950699eca5d0c848c68f`.
- PR #5 head: `7ec35724baca173298c0b8357ff4dc3bcad586e6`.
- PR #5 merged main: `71f500128b7fa13cec4821ef8fb7be0f2fa1d908`.

GitHub reported PR #5 merged and main at that merge when this audit began.
The audit used an isolated worktree; the existing dirty checkout was preserved.
Reproduction archives come from the exact commits above, not a rewritten legacy
helper. Final candidate/merge SHAs and runtime logs belong in the publishing PR.

## Evidence contract and actual consumers

| Identity | Differences that must be preserved before hashing | Intentionally excluded or normalized |
| --- | --- | --- |
| Source / selected inputs | Selected path spelling, filesystem mode, raw file bytes, raw source-link target bytes, record boundaries, known missing versus empty | Top-level path duplicates/order; timestamps, ownership and inode numbers; files outside declared selection |
| Outputs | The same records, plus directory membership/boundaries and the recursively observed contents of resolved links | Top-level duplicates/order; timestamps, ownership and inode numbers |
| Ordinary security findings | Exact stringified rule and location; normalized evidence; tuple boundaries | Evidence whitespace runs and surrounding whitespace; word-bounded `YYYY-MM-DD`-shaped tokens; null/undefined evidence become empty |

There is no Unicode normalization, case folding, newline conversion of file
contents, or general line-number removal. A location ending in `:1` differs from
`:2`. The previous normalization comment promised more than the implementation;
it has been corrected. Date normalization is syntactic, not calendar validation.
Severity, title and rationale do not enter the finding ID; kernel baseline and
blocking verdicts still consume finding data under their existing rules.

`sourceFiles()` reads cached and untracked, nonignored Git paths with `-z`.
`deliver()` excludes declared generated paths from its source freeze, splits
build/test inputs, and produces `sourceTree`, `buildInputsHash`, `testInputsHash`
through `hashPaths()`. `inputFingerprint()` selects patterns (and optional build
scope) and binds the path digest to JSON metadata: patterns and salt. Step salt
includes the step declaration, prerequisite evidence keys, Node runtime, context
and input rules. Thus equal file bytes alone do not establish reusable evidence.

Both fresh execution and reuse call the same required-output `hashPaths()`.
Reuse also requires an eligible passed receipt, equal input key, and equal
reobserved output hash / declared artifact identity. Observation failure cancels
reuse; rebuilding must establish valid observations before publishing a new
receipt. Source guards run after observations and again before final success.
The kernel's evidence contract consumes build/test hashes; it is unchanged here.

`rules.mjs` constructs ordinary finding IDs; `dedupe()` consumes them, and
`runScan()` passes findings and configured baseline IDs to kernel `baselineDiff()`.
Reports now call absent old IDs `baseline.unmatched`, not `baseline.resolved`:
an encoding change cannot prove remediation. This JSON field rename requires
report consumers to update. Kernel `diff.resolved` remains unchanged internally.
The pre-existing informational `S3.unreachable` sentinel uses the literal
`unreachable`, outside the ordinary fingerprint constructor; this audit does not
claim that sentinel is a content-derived finding ID.

### Missing and unreadable are different

A selected source path with `lstat` ENOENT emits a `missing` record. An empty
file emits mode and a zero-length `file` record. Other source read failures
propagate. Required output paths must exist, be readable and resolve inside the
root; dangling/cyclic/outside links cannot establish output evidence. Unobservable
outputs can trigger a rebuild but cannot authorize reuse or a fresh pass.

Path/glob APIs use strings. Git paths, directory entries and resolved output
paths must therefore decode as valid UTF-8; invalid byte sequences now fail
observation, rather than silently selecting a replacement-character lookalike.
Literal U+FFFD, BOM and other valid Unicode remain valid. File contents and source
symlink targets are raw buffers and may contain arbitrary bytes. Null/undefined
security evidence normalizes to empty by existing policy; that normalization is
not a claim that a failed filesystem observation equals an empty file.

## Exact bytes and decodability

The path stream is:

```text
UTF8("vibeubi-paths-v2") NUL record*
record = ASCII(kind) NUL ASCII(decimal payload byte length) NUL payload
kind = path | mode | file | link | missing | directory | end-directory
```

Lengths are canonical nonnegative decimal integers. `path` is UTF-8, `mode` is
the decimal `lstat.mode`, `file` and `link` are raw bytes, and marker payloads are
empty. Each existing path starts with `path, mode`; missing paths have
`path, missing`. A directory emits `directory`, sorted child visits, then
`end-directory`. A source link ends with its raw `link` field; an output link is
followed by a visit of its resolved target. Top-level names are deduplicated and
sorted as JavaScript strings. A required output can therefore contain repeated
records when two paths observe the same target.

A decoder reads two NUL-terminated header tokens, then consumes exactly the
specified number of bytes. NULs, apparent headers, newlines and invalid UTF-8
inside binary payloads cannot create record boundaries. The decoded record
sequence is unambiguous; reconstructing traversal ownership additionally needs
the source/output context and declared roots. This is not a portable filesystem
archive format. SHA-256 consumes the stream and returns 64 hex characters.
`inputFingerprint` hashes that fixed-width digest followed by the UTF-8 JSON
serialization of `{patterns, salt}` (functions in salt use their string form).

Finding hash input is the UTF-8 encoding of this JSON array, using
`JSON.stringify`:

```js
["vibeubi-finding-v2", String(rule), String(where), normalizedEvidence]
```

JSON string escaping and array positions preserve pipes, NULs, quotes and
backslashes without delimiter ambiguity. The result is SHA-256 truncated to
32 hex characters (128 bits). Intentional evidence normalization happens before
encoding. Unique encoding does not prove that finite hashes never collide.

## History and independently reproduced counterexamples

`c85df14` introduced concatenated path/mode/content hashing and implicit UTF-8
filesystem decoding. Later input splitting and output-link observation retained
those assumptions. `80cbd08` introduced pipe-separated finding hashing and the
scanner's `resolved` report label. PR #5 fixed record/tuple boundaries, but
framing cannot recover bytes already discarded by observation.

| Counterexample | Observation on pinned old code | Repair / remaining boundary |
| --- | --- | --- |
| Move the second file's apparent header between two binary payloads | Different file vectors and Git blob identities; identical pre-hash legacy stream; stale reuse and missed source drift | PR #5 typed byte-length records distinguish them |
| `['R','a\|b','c']` versus `['R','a','b\|c']` | Identical pipe-joined string; a distinct finding inherits baseline recognition | PR #5 JSON tuple separates fields |
| Source link target byte `80` versus `81` (hex) | PR #5 decodes both as U+FFFD; equal identity, stale reuse, source drift can pass | Read link targets as raw buffers |
| Invalid UTF-8 filename alongside a literal U+FFFD name | Git listing / directory traversal / resolved output decoding can observe the valid lookalike instead | Validate raw pathname bytes before decoding; refuse unsupported names |
| Same finding, actual v1 baseline, v2 scanner | New finding remains blocking, but old ID is reported “resolved” | Report unmatched IDs without claiming remediation |

The common cause is loss of distinctions before the decision: merging fields,
merging filesystem observations, or treating disappearance of an identifier as
disappearance of the underlying fact. No hash collision attack is needed.

## Independent checks and migration

`fingerprint-reference.test.mjs` captures actual `Hash.update` bytes. Its expected
manifests come from fixture records and an independent encoder; a cursor decoder
checks exact record recovery. SHA expectations use the reference bytes, never a
production helper. It covers 32 deterministic binary/Unicode manifests, empty
files, byte lengths, modes, timestamp exclusion, missing records, directory/link
records and injected EACCES. The security reference covers 64 separator/Unicode
tuples and fixture-specified normalization, including null/empty controls.

The old framing regressions prove equal legacy bytes before hashing and use Git
blob identity as an independent change observation. Targeted mutations restore
ambiguous encoding, lossy links/path decoding, character counts as byte lengths,
and the misleading remediation label. A killed mutation must produce the named
assertion failure; syntax errors do not count.

Run `node scripts/audit-pr5-fingerprints.mjs /tmp/pr5-audit` from a checkout with
the pinned history. It archives actual v1/v2 implementations, records archive
SHA-256 values, retains raw TAP and old serialized evidence, and executes:

| Check | `after` | Required result |
| --- | --- | --- |
| archive-v1 / archive-v2 | `[]` each | Exact pinned source available |
| old-defect-reproduction | archive-v1 | 8 assertion failures, 1 normalization control passes |
| v2-reference-encoding | archive-v2 | Independent byte contract: 5/5 |
| v2-audit-counterexamples | archive-v2 | 6 assertion failures, 1 valid-Unicode control passes |
| receipt-upgrade | both archives | v1 ran/reused; v2 rebuild required; failed rebuild preserves old evidence; successful v2 then repaired version reuse; missing output refuses pass |
| raw-link-receipt-upgrade | archive-v2 | v2 wrongly reuses changed raw target; repaired version rebuilds, then valid reuse works |
| security-baseline-upgrade | both archives | Actual v1 IDs cannot recognize v2 findings; new IDs work; old baseline bytes unchanged; report says unmatched |

Successful execution legitimately writes a new receipt; there is no receipt
conversion or automatic baseline admission. Fixture baselines simulate prior
admission solely to test identity comparison, never modify a consumer baseline.
Valid UTF-8 v2 receipts retain their encoding; no blanket version bump is needed.

The verification plan is diagnostics first, then frozen-source typecheck, all
unit tests, smoke, mutations, packed consumer tests and this migration audit,
each independent (`after: []` within the full phase). Run every independent item
even after failure; record failed/blocked/unexecuted items. Serialize runtime
suites to avoid fixed-port collisions. Repeat on the exact merged commit.

## Sources, inference and limits

- [Node Hash API](https://nodejs.org/docs/latest-v22.x/api/crypto.html#hashupdatedata-inputencoding)
  specifies streamed updates; separate calls do not promise encoded boundaries.
- [Node filesystem API](https://nodejs.org/docs/latest-v22.x/api/fs.html#fspromisesreadlinkpath-options)
  documents default UTF-8 decoding and buffer-valued link/directory/path results.
- [Node Buffer encodings](https://nodejs.org/docs/latest-v22.x/api/buffer.html#buffers-and-character-encodings)
  documents replacement characters for malformed UTF-8.
- [Git ls-files](https://git-scm.com/docs/git-ls-files) documents verbatim,
  NUL-terminated paths with `-z`.
- [RFC 8259](https://www.rfc-editor.org/rfc/rfc8259) specifies JSON arrays and
  escaped string boundaries.

These sources establish API/encoding behavior, not VibeUbi correctness. The
inference is that identity needs lossless observations followed by unambiguous
encoding. Local byte capture, old-version execution, valid/invalid controls and
mutations establish the tested cases. They are not exhaustive proofs of every
filesystem or runtime. Raw invalid-name fixtures were executed on Linux; no
cross-platform claim follows. The observations remain non-atomic: source and
artifacts must stay frozen. Undeclared external inputs remain the caller's
responsibility. Diagnostic results are not gate evidence. Complete upstream
repository/package validation is not consumer deployment evidence, which still
requires the consumer's declared chain and outside artifact observation.
