/** Reproduce PR #5 and exercise actual cross-version evidence. Diagnostic only.
 * Requires the two pinned commits in local Git history; never fetches implicitly.
 */
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, copyFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { deliver } from '../packages/ship/src/delivery.mjs'
import { runScan } from '../packages/security/src/run.mjs'

const root = resolve(import.meta.dirname, '..')
const out = resolve(process.argv[2] ?? join(root, '.vibeubi/pr5-audit'))
const temp = await mkdtemp(join(tmpdir(), 'ubi-pr5-audit-'))
await mkdir(out, { recursive: true })
const refs = { v1: '693311bfca7e6c4bcd0c950699eca5d0c848c68f', v2: '7ec35724baca173298c0b8357ff4dc3bcad586e6' }
const report = { kind: 'fingerprint-audit-diagnostic', evidence: false, runtime: process.version,
  commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), refs, results: [] }
const modules = {}, archives = {}
async function check(id, after, run) {
  if (after.some(dep => report.results.find(r => r.id === dep)?.status !== 'pass')) {
    report.results.push({ id, after, status: 'blocked' }); return
  }
  try { const detail = await run(); report.results.push({ id, after, status: 'pass', detail }) }
  catch (error) { report.results.push({ id, after, status: 'fail', reason: error.stack }) }
  console.log(`${report.results.at(-1).status} ${id}`)
}
async function archive(name) {
  const dir = join(temp, name); await mkdir(dir)
  const tar = execFileSync('git', ['archive', refs[name], 'packages', 'bin', 'package.json'], { cwd: root, maxBuffer: 32 << 20 })
  execFileSync('tar', ['-x', '-C', dir], { input: tar })
  modules[name] = { delivery: await import(pathToFileURL(join(dir, 'packages/ship/src/delivery.mjs'))),
    security: await import(pathToFileURL(join(dir, 'packages/security/src/run.mjs'))) }
  archives[name] = dir
  return { sha: refs[name], archiveSha256: createHash('sha256').update(tar).digest('hex') }
}
async function versionTests(name, files, expectedPass, expectedFail) {
  for (const file of files) await copyFile(join(root, file), join(archives[name], file))
  const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...files], { cwd: archives[name], encoding: 'utf8', timeout: 60000, maxBuffer: 8 << 20 })
  const log = `${name}-${files[0].split('/').at(-1)}.tap`
  await writeFile(join(out, log), result.stdout + result.stderr)
  assert.equal(result.status, expectedFail ? 1 : 0)
  assert.match(result.stdout, new RegExp(`^# pass ${expectedPass}$`, 'm'))
  assert.match(result.stdout, new RegExp(`^# fail ${expectedFail}$`, 'm'))
  assert.equal((result.stdout.match(/code: 'ERR_ASSERTION'/g) ?? []).length, expectedFail, 'expected reds must be assertions, not fixture/import errors')
  return { pass: expectedPass, fail: expectedFail, log }
}
async function consumer(name) {
  const dir = join(temp, name); await mkdir(dir); await mkdir(join(dir, 'dist'))
  await writeFile(join(dir, '.gitignore'), '.vibeubi/\ndist/\n')
  await writeFile(join(dir, 'source'), 'same source')
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' })
  git('init'); git('add', '.'); git('-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-m', 'fixture')
  const config = { features: [{ id: 'app', covers: ['**'], steps: ['build'], always: true }],
    steps: [{ id: 'build', inputs: ['**'], outputs: ['dist/product'], reuse: true }] }
  const execute = async () => { await writeFile(join(dir, 'dist/product'), 'same artifact'); return { ok: true } }
  const opts = { root: dir, config, execute }
  const state = async () => {
    const home = join(dir, '.vibeubi/delivery')
    const receipts = await Promise.all((await readdir(join(home, 'cache'))).sort().map(async n => [n, await readFile(join(home, 'cache', n), 'utf8')]))
    return { receipts, baseline: await readFile(join(home, 'baseline.json'), 'utf8') }
  }
  return { dir, opts, state }
}

try {
  await check('archive-v1', [], () => archive('v1'))
  await check('archive-v2', [], () => archive('v2'))
  await check('old-defect-reproduction', ['archive-v1'], () => versionTests('v1', [
    'packages/ship/test/fingerprint-framing.test.mjs', 'packages/security/test/fingerprint-framing.test.mjs',
  ], 1, 8))
  await check('v2-reference-encoding', ['archive-v2'], () => versionTests('v2', [
    'packages/ship/test/fingerprint-reference.test.mjs', 'packages/security/test/fingerprint-reference.test.mjs',
  ], 5, 0))
  await check('v2-audit-counterexamples', ['archive-v2'], () => versionTests('v2', [
    'packages/ship/test/fingerprint-bytes.test.mjs', 'packages/security/test/baseline-transition.test.mjs',
  ], 1, 6))
  await check('receipt-upgrade', ['archive-v1', 'archive-v2'], async () => {
    const f = await consumer('receipts')
    const old = await modules.v1.delivery.deliver(f.opts)
    assert.equal(old.steps.build.execution, 'ran')
    assert.equal((await modules.v1.delivery.deliver(f.opts)).steps.build.execution, 'reused')
    const before = await f.state()
    await writeFile(join(out, 'v1-receipts.json'), JSON.stringify(before, null, 2))
    const failed = await modules.v2.delivery.deliver({ ...f.opts, execute: async () => { throw Error('controlled upgrade execution failure') } })
    assert.equal(failed.status, 'failed')
    assert.deepEqual(await f.state(), before, 'failure cannot rewrite old receipts or baseline')
    const upgraded = await modules.v2.delivery.deliver(f.opts)
    assert.equal(upgraded.steps.build.execution, 'ran')
    assert.notEqual(upgraded.steps.build.key, old.steps.build.key)
    assert.equal((await modules.v2.delivery.deliver(f.opts)).steps.build.execution, 'reused')
    const v2state = await f.state()
    const current = await deliver(f.opts)
    assert.equal(current.steps.build.execution, 'reused', 'valid PR #5 receipts remain usable')
    assert.equal(current.steps.build.key, upgraded.steps.build.key)
    assert.deepEqual((await f.state()).receipts, v2state.receipts)
    await rm(join(f.dir, 'dist/product'))
    const missing = await deliver({ ...f.opts, execute: async () => ({ ok: true }) })
    assert.equal(missing.status, 'failed')
    assert.deepEqual((await f.state()).receipts, v2state.receipts)
    return { oldKey: old.steps.build.key, upgradedKey: upgraded.steps.build.key, currentExecution: current.steps.build.execution }
  })
  await check('raw-link-receipt-upgrade', ['archive-v2'], async () => {
    const f = await consumer('links'), link = join(f.dir, 'link')
    await symlink(Buffer.from([0x80]), link)
    const old = await modules.v2.delivery.deliver(f.opts)
    assert.equal(old.status, 'passed')
    await rm(link); await symlink(Buffer.from([0x81]), link)
    assert.equal((await modules.v2.delivery.deliver(f.opts)).steps.build.execution, 'reused')
    const current = await deliver(f.opts)
    assert.equal(current.steps.build.execution, 'ran')
    assert.notEqual(current.steps.build.key, old.steps.build.key)
    assert.equal((await deliver(f.opts)).steps.build.execution, 'reused')
    return { oldKey: old.steps.build.key, currentKey: current.steps.build.key }
  })
  await check('security-baseline-upgrade', ['archive-v1', 'archive-v2'], async () => {
    const dir = join(temp, 'scanner'); await mkdir(dir)
    await writeFile(join(dir, 'route.js'), 'export function GET() { return "still ungated" }')
    const opts = { root: dir, layers: ['S2'], config: { gateTokens: ['requireAuth'] },
      discovered: [{ kind: 'api', path: '/api/sample', source: 'route.js' }] }
    const old = await modules.v1.security.runScan(opts)
    assert.equal(old.findings.length, 1)
    const baseline = old.findings.map(f => ({ fingerprint: f.fingerprint }))
    const serialized = JSON.stringify(baseline)
    await writeFile(join(out, 'v1-security-baseline.json'), serialized)
    const withBaseline = { ...opts, config: { ...opts.config, baseline } }
    assert.equal((await modules.v1.security.runScan(withBaseline)).baseline.known, 1)
    const v2 = await modules.v2.security.runScan(withBaseline), current = await runScan(withBaseline)
    assert.equal(v2.baseline.resolved, 1)
    assert.equal(current.baseline.unmatched, 1)
    assert.equal(Object.hasOwn(current.baseline, 'resolved'), false)
    for (const result of [v2, current]) {
      assert.equal(result.baseline.known, 0); assert.equal(result.baseline.new, 1)
      assert.equal(result.blocking.length, 1)
      for (const k of ['rule', 'where', 'evidence']) assert.equal(result.findings[0][k], old.findings[0][k])
    }
    const newBaseline = v2.findings.map(f => ({ fingerprint: f.fingerprint }))
    const known = await runScan({ ...opts, config: { ...opts.config, baseline: newBaseline } })
    assert.equal(known.baseline.known, 1); assert.deepEqual(known.blocking, [])
    assert.equal(JSON.stringify(baseline), serialized)
    assert.equal(await readFile(join(out, 'v1-security-baseline.json'), 'utf8'), serialized)
    return { old: old.findings[0].fingerprint, v2: v2.findings[0].fingerprint,
      v2Report: v2.baseline, currentReport: current.baseline, freshBaseline: known.baseline }
  })
} finally {
  await rm(temp, { recursive: true, force: true })
  report.failed = report.results.filter(r => r.status === 'fail').map(r => r.id)
  report.blocked = report.results.filter(r => r.status === 'blocked').map(r => r.id)
  report.notRun = []
  report.clean = report.results.length === 8 && report.results.every(r => r.status === 'pass')
  await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n')
}
console.log(`fingerprint audit diagnostic: ${report.results.filter(r => r.status === 'pass').length}/8 obligations established`)
process.exitCode = report.clean ? 0 : 1
