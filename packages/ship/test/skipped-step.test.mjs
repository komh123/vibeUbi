/**
 * deliver(): a step may report itself `skipped` (environment-blocked) instead of
 * pass or fail. It is opt-in, by the executor's explicit result, and never evidence.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { deliver } from '../src/delivery.mjs'
import { countsAsEvidence } from '../../kernel/src/index.mjs'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'ubi-skipped-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, '.gitignore'), '.vibeubi/\n'); await writeFile(join(root, 'a.txt'), 'a')
  const git = args => execFileSync('git', args, { cwd: root, stdio: 'pipe' }).toString().trim()
  git(['init']); git(['add', '.']); git(['-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-m', 'x'])
  const config = { recordBaseline: false, features: [{ id: 'f', covers: ['**'], steps: ['login', 'checkout', 'search'], always: true }],
    steps: [{ id: 'login', phase: 'acceptance', always: true }, { id: 'checkout', phase: 'acceptance', after: ['login'] }, { id: 'search', phase: 'acceptance', always: true }] }
  return { root, config }
}
const SKIP = { ok: false, status: 'skipped', category: 'environment-blocked', reason: 'bypass-rewind: git write-tree denied on this site' }

// A gate-shaped view of a delivery report, the way a consumer asks countsAsEvidence about it.
const asGate = (r, ok = r.status === 'passed') => [{ ...r, ok, phase: 'build' }, { phase: 'build', buildInputsHash: r.buildInputsHash }]

test('a skipped step is its own row; its dependent is blocked, an independent step still runs', async t => {
  const f = await fixture(t), ran = []
  const r = await deliver({ ...f, execute: async s => { ran.push(s.id); return s.id === 'login' ? SKIP : { ok: true } } })
  assert.deepEqual(r.steps.login, { ...r.steps.login, status: 'skipped', category: 'environment-blocked', reason: SKIP.reason })
  assert.equal(r.steps.checkout.status, 'blocked'); assert.deepEqual(r.steps.checkout.blockedBy, ['login'])
  assert.equal(r.steps.search.status, 'pass'); assert.deepEqual(ran.sort(), ['login', 'search'])
  assert.deepEqual(r.outcome.skipped, ['login'])
  assert.equal(r.outcome.clean, false)
})

test('a delivery with a skipped step is not passed, records no baseline, and is never evidence', async t => {
  const f = await fixture(t)
  const r = await deliver({ ...f, config: { ...f.config, recordBaseline: true }, execute: async s => s.id === 'login' ? SKIP : { ok: true } })
  assert.equal(r.status, 'failed')
  await assert.rejects(readFile(join(f.root, '.vibeubi/delivery/baseline.json')), { code: 'ENOENT' })
  const v = countsAsEvidence(...asGate(r, true)) // even if a caller wrongly claims ok
  assert.equal(v.ok, false); assert.match(v.reason, /skipped/)
  const disk = JSON.parse(await readFile(join(r.outDir, 'report.json'), 'utf8'))
  assert.equal(disk.steps.login.status, 'skipped')
})

test('a skipped step leaves no reusable receipt', async t => {
  const f = await fixture(t)
  const cfg = { ...f.config, steps: f.config.steps.map(s => s.id === 'login' ? { ...s, reuse: true, outputs: ['a.txt'] } : s) }
  await deliver({ ...f, config: cfg, execute: async s => s.id === 'login' ? SKIP : { ok: true } })
  const names = await import('node:fs/promises').then(m => m.readdir(join(f.root, '.vibeubi/delivery/cache')))
  assert.deepEqual(names, [], 'no receipt, so the next run cannot treat the skip as built')
})

test('skipped is refused unless it is unambiguous: a reason is required, and ok:true contradicts it', async t => {
  const f = await fixture(t)
  const noReason = await deliver({ ...f, execute: async s => s.id === 'login' ? { ok: false, status: 'skipped' } : { ok: true } })
  assert.equal(noReason.steps.login.status, 'fail'); assert.match(noReason.steps.login.reason, /skipped.*reason/)
  const both = await deliver({ ...f, execute: async s => s.id === 'login' ? { ok: true, status: 'skipped', reason: 'x' } : { ok: true } })
  assert.equal(both.steps.login.status, 'fail'); assert.match(both.steps.login.reason, /contradict|ok:\s*true/)
})

test('default behaviour is unchanged: without a skipped result nothing differs', async t => {
  const f = await fixture(t)
  const bad = await deliver({ ...f, execute: async s => s.id === 'login' ? { ok: false } : { ok: true } })
  assert.equal(bad.steps.login.status, 'fail'); assert.match(bad.steps.login.reason, /no affirmative execution evidence/)
  assert.equal(bad.steps.checkout.status, 'blocked')
  assert.equal('skipped' in bad.outcome, false, 'reports without skipped steps keep their old shape')
  const good = await deliver({ ...f, execute: async () => ({ ok: true }) })
  assert.equal(good.status, 'passed'); assert.equal(countsAsEvidence(...asGate(good)).ok, true)
})
