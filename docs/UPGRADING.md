# Updating a consumer project

Use a tested merge commit, not a moving branch, and update the dependency and
lockfile together in an isolated checkout. VibeUbi requires Node 22 or newer.
Keep the consumer source frozen during verification. Upstream repository tests
and package-import checks do not establish that the consumer has been deployed.

## Review the integration before running a release

- Inventory imports from `vibeubi`, `vibeubi/kernel`, `vibeubi/delivery` and
  `vibeubi/artifacts`, plus locally copied evidence predicates and schedulers.
  Installing a new package cannot update copied functions. Compare those copies
  against the upstream contract; run valid/invalid evidence pairs before changing
  a consumer's gate. Do not replace predicates merely to make a red disappear.
- Confirm that subprocess tests emit a machine-readable test count. For Node's
  test runner, explicitly use `--test --test-reporter=tap`; a runtime's default
  reporter is not an evidence contract.
- Inspect `checklist.steps[*].after`. Selected preflight barriers apply to all
  later work; selected full-only checks additionally precede ordinary work in
  full mode. A full-only check that depends on that ordinary work forms a cycle.
  Express post-build acceptance as an ordinary step with its build prerequisite.
- Expect a rebuild when newly explicit prerequisites change a receipt's cache
  key, or an output symlink gains target-byte binding. Never rewrite old receipts
  or source stamps to manufacture a cache hit.
- Check output links: targets must exist inside the project root and directory
  links must not form cycles. Use an explicit identity observation for external
  artifacts instead of assuming an outside-root symlink proves their contents.
- Step deadlines include execution and identity observations together. Injected
  observers must honor the supplied cancellation signal to stop side effects.

## Verify in dependency order

1. Run affected adapter/evidence diagnostics, including invalid evidence cases.
   These results are diagnostic and cannot authorize deployment.
2. Write the consumer's required check plan with `after` dependencies. Run all
   independent checks, collect failures/blocked/not-run outcomes, and fix the
   causes before restarting a slow chain. Serialize suites that share ports.
3. Run the appropriate complete declared delivery for the exact consumer tree.
   Ordinary updates remain incremental unless the owner requests full mode or
   a concrete declared major-change reason applies.
4. Establish consumer deployment with external observation of the expected new
   artifact, followed by its bounded acceptance plan. Package installation,
   upstream tests and a reusable build alone do not establish this claim.

No project-specific path, port, feature name or deployment exception belongs in
the upstream defaults. Keep those declarations in the consumer adapter.
