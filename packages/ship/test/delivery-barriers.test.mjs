import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { checklist, deliver } from '../src/delivery.mjs'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'ubi-barriers-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, '.gitignore'), '.vibeubi/\ndist/\n')
  await writeFile(join(root, 'source'), 'source')
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' })
  git('init'); git('add', '.'); git('-c', 'user.email=test@example.com', '-c', 'user.name=test', 'commit', '-m', 'fixture')
  // Intentionally put a consumer before the barriers. Declaration order alone
  // must never decide whether a prerequisite runs first or appears in a report.
  const config = { features: [{ id: 'product', covers: ['**'], steps: ['publish'], always: true }], steps: [
    { id: 'build', phase: 'build', inputs: ['source'], outputs: ['dist/product'], reuse: true },
    { id: 'check-one', phase: 'preflight', always: true },
    { id: 'check-two', phase: 'preflight', always: true },
    { id: 'verify-one', fullOnly: true },
    { id: 'verify-two', fullOnly: true },
    { id: 'accept', after: ['build'] },
    { id: 'publish', after: ['accept'], mutates: true },
  ] }
  const calls = []
  const execute = async s => {
    calls.push(s.id)
    if (s.id === 'build') { await mkdir(join(root, 'dist'), { recursive: true }); await writeFile(join(root, 'dist/product'), 'artifact') }
    return { ok: true }
  }
  return { root, config, calls, execute }
}

for (const full of [false, true]) {
  test(`the published plan includes every active barrier (${full ? 'full' : 'incremental'})`, async t => {
    const f = await fixture(t), original = structuredClone(f.config)
    const plan = await checklist({ ...f, full })
    const row = id => plan.steps.find(s => s.id === id)
    assert.deepEqual(row('build').after, full ? ['check-one', 'check-two', 'verify-one', 'verify-two'] : ['check-one', 'check-two'])
    assert.deepEqual(row('check-one').after, [])
    assert.equal(row('verify-one').selected, full)
    if (full) assert.deepEqual(row('verify-one').after, ['check-one', 'check-two'])
    assert.deepEqual(f.config, original, 'compiling dependencies must not mutate the caller declaration')
  })

  test(`a failed barrier reports its blocked dependents and still runs its sibling (${full ? 'full' : 'incremental'})`, async t => {
    const f = await fixture(t)
    const report = await deliver({ ...f, full, execute: async s => {
      if (s.id === 'check-one') { f.calls.push(s.id); throw Error('unavailable prerequisite') }
      return f.execute(s)
    } })
    assert.equal(report.status, 'failed')
    assert.deepEqual(f.calls, ['check-one', 'check-two'])
    const blocked = full ? ['build', 'verify-one', 'verify-two', 'accept', 'publish'] : ['build', 'accept', 'publish']
    for (const id of blocked) {
      assert.equal(report.steps[id].status, 'blocked', id)
      assert.deepEqual(report.steps[id].blockedBy, ['check-one'])
    }
    assert.deepEqual(report.outcome.fixFirst, [{ id: 'check-one', blocks: blocked.length }])
    assert.equal(report.outcome.items.filter(s => s.status === 'not-run').length, 0)
  })

  test(`healthy barriers preserve prerequisite order (${full ? 'full' : 'incremental'})`, async t => {
    const f = await fixture(t)
    assert.equal((await deliver({ ...f, full })).status, 'passed')
    assert.deepEqual(f.calls, ['check-one', 'check-two', ...(full ? ['verify-one', 'verify-two'] : []), 'build', 'accept', 'publish'])
  })
}

test('a failed full-only check still runs independent full checks and attributes blocked work', async t => {
  const f = await fixture(t)
  const report = await deliver({ ...f, full: true, execute: async s => {
    if (s.id === 'verify-one') { f.calls.push(s.id); throw Error('verification failed') }
    return f.execute(s)
  } })
  assert.deepEqual(f.calls, ['check-one', 'check-two', 'verify-one', 'verify-two'])
  assert.equal(report.steps['verify-two'].status, 'pass')
  for (const id of ['build', 'accept', 'publish']) {
    assert.equal(report.steps[id].status, 'blocked')
    assert.deepEqual(report.steps[id].blockedBy, ['verify-one'])
  }
  assert.deepEqual(report.outcome.fixFirst, [{ id: 'verify-one', blocks: 3 }])
})

test('a dependency across the full-only barrier is rejected before executing any step', async t => {
  const f = await fixture(t)
  f.config.steps.find(s => s.id === 'verify-one').after = ['build']
  // The incremental graph is valid because this full-only check is not selected.
  assert.equal((await deliver(f)).status, 'passed')
  f.calls.length = 0
  const report = await deliver({ ...f, full: true })
  assert.equal(report.status, 'failed')
  assert.match(report.error, /dependency cycle/)
  assert.deepEqual(f.calls, [], 'invalid effective plans must fail before even a preflight executes')
})

test('a changed barrier declaration invalidates dependent build receipts', async t => {
  const f = await fixture(t)
  assert.equal((await deliver(f)).steps.build.execution, 'ran')
  assert.equal((await deliver(f)).steps.build.execution, 'reused')
  f.config.steps.find(s => s.id === 'check-one').cmd = ['new-preflight-contract']
  assert.equal((await deliver(f)).steps.build.execution, 'ran')
  assert.equal((await deliver(f)).steps.build.execution, 'reused')
})
