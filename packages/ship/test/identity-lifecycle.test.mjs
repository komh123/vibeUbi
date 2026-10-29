import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { deliver } from '../src/delivery.mjs'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const read = file => readFile(file, 'utf8').catch(e => { if (e.code === 'ENOENT') return null; throw e })
const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }
async function fixture(t, budget = 'step') {
  const root = await mkdtemp(join(tmpdir(), 'ubi-identity-life-'))
  await mkdir(join(root, '.vibeubi'))
  await writeFile(join(root, '.gitignore'), '.vibeubi/\n')
  await writeFile(join(root, 'source.js'), 'source')
  await writeFile(join(root, 'probe.mjs'), `
    import { readFileSync, writeFileSync } from 'node:fs';
    import { spawn } from 'node:child_process';
    const c = JSON.parse(readFileSync('.vibeubi/control.json'));
    let child;
    if (c.child) {
      child = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{}); require('fs').writeFileSync('.vibeubi/child-ready','ready'); setInterval(()=>{},1000)"], { stdio: 'ignore' });
      child.unref();
    }
    writeFileSync('.vibeubi/probe.json', JSON.stringify({ pid: process.pid, child: child?.pid }));
    console.error('stderr is not artifact identity');
    setTimeout(() => console.log('artifact-a'), c.delay || 0);
  `)
  const config = { totalBudgetMs: budget === 'total' ? 1200 : 10000,
    features: [{ id: 'app', always: true, covers: ['**'], steps: ['build'] }],
    steps: [{ id: 'build', phase: 'build', reuse: true, timeoutMs: budget === 'step' ? 1200 : 10000,
      cmd: [process.execPath, '-e', "require('fs').appendFileSync('.vibeubi/builds','build\\n')"],
      identity: [process.execPath, 'probe.mjs'] }],
  }
  await writeFile(join(root, 'vibeubi.config.mjs'), `export default {delivery:${JSON.stringify(config)}}`)
  const git = args => execFileSync('git', args, { cwd: root, stdio: 'ignore' })
  git(['init']); git(['add', '.']); git(['-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-m', 'fixture'])
  const control = value => writeFile(join(root, '.vibeubi/control.json'), JSON.stringify(value))
  await control({})
  t.after(async () => {
    const pids = JSON.parse(await read(join(root, '.vibeubi/probe.json')) || '{}')
    for (const pid of [pids.pid, pids.child].filter(Boolean)) { try { process.kill(pid, 'SIGKILL') } catch {} }
    await rm(root, { recursive: true, force: true })
  })
  const home = join(root, '.vibeubi/delivery')
  const receipts = async () => {
    const names = await readdir(join(home, 'cache')).catch(e => { if (e.code === 'ENOENT') return []; throw e })
    return Promise.all(names.sort().map(async name => [name, await read(join(home, 'cache', name))]))
  }
  return { root, config, control, receipts, readBaseline: () => read(join(home, 'baseline.json')) }
}

for (const budget of ['step', 'total']) for (const path of ['fresh', 'reuse']) {
  test(`identity respects the remaining ${budget} budget before publication (${path})`, async t => {
    const f = await fixture(t, budget)
    if (path === 'reuse') {
      const good = await deliver(f)
      assert.equal(good.status, 'passed')
      assert.equal(good.steps.build.artifact, 'artifact-a', 'stderr must not contaminate the identity')
    }
    const before = await f.receipts(), baseline = await f.readBaseline()
    const builds = await read(join(f.root, '.vibeubi/builds'))
    await f.control({ delay: 4000 })
    const started = Date.now()
    const result = await deliver(f)
    assert.ok(await read(join(f.root, '.vibeubi/probe.json')), 'the identity probe actually started')
    assert.equal(result.status, 'failed')
    assert.equal(result.steps.build.status, 'fail')
    assert.match(result.steps.build.reason, /budget|timed out/i)
    assert.ok(Date.now() - started < 3000, 'the probe must be stopped at its budget, not merely rejected after returning late')
    assert.deepEqual(await f.receipts(), before)
    assert.equal(await f.readBaseline(), baseline)
    if (path === 'reuse') assert.equal(await read(join(f.root, '.vibeubi/builds')), builds, 'an exhausted probe must not fall back into another build')
  })
}

for (const path of ['fresh', 'reuse']) {
  test(`interrupting a final identity probe kills its process tree and cannot publish success (${path})`, async t => {
    const f = await fixture(t, 'interrupt')
    if (path === 'reuse') assert.equal((await deliver(f)).status, 'passed')
    const before = await f.receipts(), baseline = await f.readBaseline()
    const builds = await read(join(f.root, '.vibeubi/builds'))
    await rm(join(f.root, '.vibeubi/probe.json'), { force: true })
    await f.control({ delay: 1400, child: true })
    const cli = new URL('../../../bin/vibeubi.mjs', import.meta.url).pathname.replace('/packages/bin/', '/bin/')
    const child = spawn(process.execPath, [cli, 'ship', '--root', f.root], { stdio: ['ignore', 'pipe', 'pipe'] })
    let cliOutput = ''
    child.stdout.on('data', chunk => { cliOutput += chunk })
    child.stderr.on('data', chunk => { cliOutput += chunk })
    t.after(() => { try { child.kill('SIGKILL') } catch {} })
    const exited = new Promise(resolve => child.once('exit', resolve))
    let pids
    for (let i = 0; i < 200; i++) {
      const value = await read(join(f.root, '.vibeubi/probe.json'))
      if (value && await read(join(f.root, '.vibeubi/child-ready'))) { pids = JSON.parse(value); break }
      if (child.exitCode !== null) break
      await sleep(25)
    }
    assert.ok(pids?.child && alive(pids.pid) && alive(pids.child), `probe and grandchild must exist before interruption: ${cliOutput}`)
    child.kill('SIGTERM')
    assert.equal(await exited, 1)
    const result = JSON.parse(await read(join(f.root, '.vibeubi/delivery/status.json')))
    assert.equal(result.status, 'failed'); assert.equal(result.interruptedBy, 'SIGTERM')
    assert.equal(result.steps.build.status, 'fail')
    await sleep(100)
    assert.equal(alive(pids.pid), false); assert.equal(alive(pids.child), false)
    assert.deepEqual(await f.receipts(), before); assert.equal(await f.readBaseline(), baseline)
    if (path === 'reuse') assert.equal(await read(join(f.root, '.vibeubi/builds')), builds)
  })
}

test('an injected identity observer receives an abort signal and cannot publish its late result', async t => {
  const f = await fixture(t)
  let signal
  const result = await deliver({ ...f, identify: async (_step, context) => {
    signal = context.signal
    process.emit('SIGTERM')
    return 'artifact-a'
  } })
  assert.equal(result.status, 'failed')
  assert.equal(signal?.aborted, true)
  assert.deepEqual(await f.receipts(), [])
  assert.equal(await f.readBaseline(), null)
})

test('an injected identity observer is bounded even when it ignores the deadline', async t => {
  const f = await fixture(t)
  f.config.steps[0].timeoutMs = 1000
  let signal
  const result = await deliver({ ...f, identify: async (_step, context) => {
    signal = context.signal
    await sleep(1600)
    return 'artifact-a'
  } })
  assert.equal(result.status, 'failed')
  assert.equal(signal?.aborted, true)
  assert.deepEqual(await f.receipts(), [])
  assert.equal(await f.readBaseline(), null)
})

test('an exhausted total budget reports independent work not-run and dependents blocked', async t => {
  const f = await fixture(t, 'total')
  f.config.steps.push({ id: 'independent', cmd: [process.execPath, '-e', 'process.exit(0)'] },
    { id: 'dependent', after: ['build'], cmd: [process.execPath, '-e', 'process.exit(0)'] })
  f.config.features[0].steps.push('independent', 'dependent')
  await f.control({ delay: 4000 })
  const result = await deliver(f)
  assert.equal(result.steps.build.status, 'fail')
  assert.equal(result.steps.independent.status, 'not-run')
  assert.equal(result.steps.dependent.status, 'blocked')
  assert.deepEqual(result.steps.dependent.blockedBy, ['build'])
})

test('a step timeout blocks dependents but independent work still completes', async t => {
  const f = await fixture(t)
  f.config.steps.push({ id: 'independent', cmd: [process.execPath, '-e', 'process.exit(0)'] },
    { id: 'dependent', after: ['build'], cmd: [process.execPath, '-e', 'process.exit(0)'] })
  f.config.features[0].steps.push('independent', 'dependent')
  await f.control({ delay: 4000 })
  const result = await deliver(f)
  assert.equal(result.steps.build.status, 'fail')
  assert.equal(result.steps.independent.status, 'pass')
  assert.equal(result.steps.dependent.status, 'blocked')
})

test('interruption at the last checkpoint prevents final success and baseline publication', async t => {
  const f = await fixture(t)
  const result = await deliver({ ...f, emit: ({ kind, report }) => {
    if (kind === 'status' && report.status === 'running' && report.steps.build?.status === 'pass') process.emit('SIGTERM')
  } })
  assert.equal(result.status, 'failed')
  assert.equal(result.interruptedBy, 'SIGTERM')
  assert.equal(await f.readBaseline(), null)
})
