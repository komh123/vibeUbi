/** Targeted falsification of the PR #1 guards, in disposable copies only. */
import { cp, mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync, execFileSync } from 'node:child_process'
import { inputFingerprint } from '../packages/ship/src/delivery.mjs'

const root = resolve(import.meta.dirname, '..')
const out = join(root, '.vibeubi/evidence-mutations')
await mkdir(out, { recursive: true })
const sandbox = await mkdtemp(join(tmpdir(), 'vibeubi-mutations-'))
const kernel = 'packages/kernel/src/diagnose.mjs'
const delivery = 'packages/ship/src/delivery.mjs'
const contractTests = ['packages/kernel/test/evidence-contract.test.mjs', 'packages/ship/test/input-split.test.mjs']
const lifecycleTests = ['packages/ship/test/identity-lifecycle.test.mjs']
const outputTests = ['packages/ship/test/output-links.test.mjs']
const barrierTests = ['packages/ship/test/delivery-barriers.test.mjs']
const framingTests = ['packages/ship/test/fingerprint-framing.test.mjs', 'packages/security/test/fingerprint-framing.test.mjs']
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
const source = await inputFingerprint(root, ['**'])
const report = { kind: 'mutation-diagnostic', evidence: false, commit: git('rev-parse', 'HEAD'), tree: git('rev-parse', 'HEAD^{tree}'), source, runtime: process.version, results: [] }
const mutations = [
  { id: 'unreadable-equality', file: kernel,
    from: 'const sameFingerprint = (a, b) => sameObserved(\n  typeof a === "string" ? a : null,\n  typeof b === "string" ? b : null,\n).same',
    to: 'const sameFingerprint = (a, b) => a === b',
    fails: 'fingerprint equality is meaningful' },
  { id: 'optional-build-binding', file: kernel,
    from: 'if (!sameFingerprint(r.buildInputsHash, want.buildInputsHash))',
    to: 'if (want.buildInputsHash !== undefined && !sameFingerprint(r.buildInputsHash, want.buildInputsHash))',
    fails: 'build evidence needs an expected build fingerprint' },
  { id: 'reuse-fallback-with-stale-source', file: delivery,
    from: '          await assertSourceUnchanged()\n          assertActive()\n        }\n        if (!reused)',
    to: '          assertActive()\n        }\n        if (!reused)',
    fails: 'source freeze covers the final identity observation \\(reuse-mismatch\\)' },
  { id: 'publish-before-observation-guard', file: delivery,
    from: '        await assertSourceUnchanged()\n        assertActive()\n        if (!reused && s.reuse',
    to: '        assertActive()\n        if (!reused && s.reuse',
    fails: 'source freeze covers the final identity observation \\(fresh\\)' },
  { id: 'no-final-source-check', file: delivery,
    from: '    if (passed) await assertSourceUnchanged()', to: '',
    fails: 'source freeze is checked again before final success' },
  { id: 'identity-ignores-remaining-budget', file: delivery,
    from: 'timeoutMs = Math.min(60000, timeoutMs)', to: 'timeoutMs = 60000',
    tests: lifecycleTests, pattern: 'identity respects the remaining step budget.*fresh',
    fails: 'identity respects the remaining step budget before publication \\(fresh\\)' },
  { id: 'identity-ignores-interrupt', file: delivery,
    from: 'const identity = () => observeIdentity(root, s, identify, { outDir, signal: controller.signal, timeoutMs: remaining() })',
    to: 'const identity = () => observeIdentity(root, s, identify, { outDir, signal: new AbortController().signal, timeoutMs: remaining() })',
    tests: lifecycleTests, pattern: 'interrupting a final identity probe.*fresh',
    fails: 'interrupting a final identity probe kills its process tree and cannot publish success \\(fresh\\)' },
  { id: 'injected-observer-has-no-watchdog', file: delivery,
    from: "timer = setTimeout(() => stop(new Error('Identity observation timed out')), timeoutMs)", to: 'timer = undefined',
    tests: lifecycleTests, pattern: 'an injected identity observer is bounded',
    fails: 'an injected identity observer is bounded even when it ignores the deadline' },
  { id: 'no-final-interruption-check', file: delivery,
    from: '    if (passed) assertDeliveryActive()', to: '',
    tests: lifecycleTests, pattern: 'interruption at the last checkpoint',
    fails: 'interruption at the last checkpoint prevents final success and baseline publication' },
  { id: 'aborted-leader-leaves-descendants', file: 'packages/ship/src/run.mjs',
    from: '  if (signal?.aborted) killGroup("SIGKILL")', to: '',
    tests: lifecycleTests, pattern: 'interrupting a final identity probe.*fresh',
    fails: 'interrupting a final identity probe kills its process tree and cannot publish success \\(fresh\\)' },
  { id: 'output-link-ignores-target-bytes', file: delivery,
    from: 'if (required) await visit(relative(outputRoot, actual), ancestors)', to: '',
    tests: outputTests, pattern: 'output links pin target bytes.*file',
    fails: 'output links pin target bytes before reuse \\(file\\)' },
  { id: 'output-parent-escapes-root', file: delivery,
    from: 'if (required && outside(relative(outputRoot, actual))) throw Error(`Output resolves outside root: ${name}`)', to: '',
    tests: outputTests, pattern: 'output paths cannot escape through a symlink parent.*fresh',
    fails: 'output paths cannot escape through a symlink parent \\(fresh\\)' },
  { id: 'preflight-missing-from-plan', file: delivery,
    from: '...(s.after ?? []), ...preflight, ...(s.fullOnly ? [] : full)',
    to: '...(s.after ?? []), ...(s.fullOnly ? [] : full)',
    tests: barrierTests, pattern: 'the published plan includes every active barrier.*incremental',
    fails: 'the published plan includes every active barrier \\(incremental\\)' },
  { id: 'runner-discards-effective-dependencies', file: delivery,
    from: 'config.steps.filter(s => selected.has(s.id)).map(s => withAfter(s, plannedById.get(s.id).after))',
    to: 'config.steps.filter(s => selected.has(s.id))',
    tests: barrierTests, pattern: 'a failed barrier reports.*incremental',
    fails: 'a failed barrier reports its blocked dependents and still runs its sibling \\(incremental\\)' },
  { id: 'cache-discards-prerequisite-evidence', file: delivery,
    from: 'deps: (s.after ?? []).map(d => keys[d])', to: 'deps: []',
    tests: barrierTests, pattern: 'a changed barrier declaration',
    fails: 'a changed barrier declaration invalidates dependent build receipts' },
  { id: 'ambiguous-file-records', file: delivery,
    from: "hash.update(kind + '\\0' + bytes.length + '\\0')\n    hash.update(bytes)",
    to: "if (kind === 'path' || kind === 'mode') hash.update(Buffer.concat([bytes, Buffer.from('\\0')]))\n    else if (kind === 'file') hash.update(bytes)\n    else if (kind === 'link') hash.update('link:' + value)\n    else if (kind === 'missing') hash.update('missing\\0')",
    tests: framingTests, pattern: 'input fingerprints distinguish file boundaries',
    fails: 'input fingerprints distinguish file boundaries even when legacy streams are identical' },
  { id: 'ambiguous-finding-fields', file: 'packages/security/src/rules.mjs',
    from: "JSON.stringify(['vibeubi-finding-v2', String(rule), String(where), normalise(evidence)])",
    to: '`${rule}|${where}|${normalise(evidence)}`',
    tests: framingTests, pattern: 'finding fingerprints distinguish location',
    fails: 'finding fingerprints distinguish location and evidence field boundaries' },
]
const runTests = (tests, pattern) => spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...(pattern ? ['--test-name-pattern', pattern] : []), ...tests], { cwd: sandbox, encoding: 'utf8', timeout: 60000, maxBuffer: 32 << 20 })
try {
  await cp(join(root, 'packages'), join(sandbox, 'packages'), { recursive: true })
  await cp(join(root, 'bin'), join(sandbox, 'bin'), { recursive: true })
  await cp(join(root, 'package.json'), join(sandbox, 'package.json'))
  const baseline = runTests([...contractTests, ...lifecycleTests, ...outputTests, ...barrierTests, ...framingTests])
  const baselineOutput = (baseline.stdout ?? '') + (baseline.stderr ?? '')
  await writeFile(join(out, 'baseline.tap'), baselineOutput)
  if (baseline.status !== 0 || !/^# pass [1-9]\d*$/m.test(baselineOutput)) throw Error('Mutation baseline did not run and pass its regression tests')
  for (const mutation of mutations) {
    const file = join(sandbox, mutation.file)
    const original = await readFile(file, 'utf8')
    if (original.split(mutation.from).length !== 2) throw Error(`${mutation.id}: mutation target must occur exactly once`)
    await writeFile(file, original.replace(mutation.from, mutation.to))
    const syntax = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
    if (syntax.status !== 0) throw Error(`${mutation.id}: invalid syntax is not a killed semantic mutation`)
    const result = runTests(mutation.tests ?? contractTests, mutation.pattern)
    const output = (result.stdout ?? '') + (result.stderr ?? '')
    await writeFile(join(out, `${mutation.id}.tap`), output)
    const killed = result.status === 1 && new RegExp(`^not ok \\d+ - ${mutation.fails}`, 'm').test(output)
    report.results.push({ id: mutation.id, killed, exit: result.status, expectedFailure: mutation.fails })
    console.log(`${killed ? 'killed' : 'SURVIVED'} ${mutation.id}`)
    await writeFile(file, original)
  }
  report.sourceUnchanged = source === await inputFingerprint(root, ['**'])
  report.clean = report.sourceUnchanged && report.results.length === mutations.length && report.results.every(r => r.killed)
} catch (error) {
  report.clean = false
  report.error = error.message
  console.error(error.message)
} finally {
  await rm(sandbox, { recursive: true, force: true })
  await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n')
}
console.log(`mutation diagnostic: ${report.results.filter(r => r.killed).length}/${mutations.length} killed; ${out}/report.json`)
process.exitCode = report.clean ? 0 : 1
