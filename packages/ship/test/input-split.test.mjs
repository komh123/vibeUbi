// Build inputs vs test inputs: a falsifiable pair (test-only edit reuses the build,
// build edit rebuilds), the fail-safe default, and the artifact-identity pin.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { deliver, inputFingerprint } from '../src/delivery.mjs'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'ubi-split-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const d of ['web', 'scripts/acceptance']) await mkdir(join(root, d), { recursive: true })
  await writeFile(join(root, '.gitignore'), '.vibeubi/\ndist/\n')
  await writeFile(join(root, 'web/a.js'), 'web-v1')
  await writeFile(join(root, 'SHIPS.md'), 'ships-v1')
  await writeFile(join(root, 'scripts/acceptance/web.mjs'), 'accept-v1')
  await writeFile(join(root, 'package-lock.json'), 'lock-v1')
  const git = args => execFileSync('git', args, { cwd: root, stdio: 'pipe' }).toString().trim()
  git(['init']); git(['add', '.']); git(['-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-m', 'initial'])
  const config = {
    testInputs: ['SHIPS.md', 'scripts/acceptance/**'],
    features: [{ id: 'web', covers: ['**'], steps: ['web-build', 'web-test'] }],
    steps: [
      { id: 'preflight', phase: 'preflight', always: true },
      // no `inputs`: the build hashes the whole tree minus test inputs
      { id: 'web-build', phase: 'build', outputs: ['dist/web'], reuse: true, after: ['preflight'] },
      { id: 'web-test', phase: 'acceptance', after: ['web-build'] },
    ],
  }
  const calls = []
  const execute = async s => {
    calls.push(s.id)
    if (s.id === 'web-build') { await mkdir(join(root, 'dist'), { recursive: true }); await writeFile(join(root, 'dist/web'), await readFile(join(root, 'web/a.js'))) }
    return { ok: true }
  }
  return { root, config, calls, execute, changed: ['web/a.js'] }
}
const edit = (f, file, text) => writeFile(join(f.root, file), text)

test('PAIR (a): editing only testInputs leaves the build REUSED, re-runs acceptance, moves only testInputsHash', async t => {
  const f = await fixture(t); const r0 = await deliver(f); assert.equal(r0.status, 'passed')
  f.calls.length = 0
  await edit(f, 'SHIPS.md', 'ships-v2'); await edit(f, 'scripts/acceptance/web.mjs', 'accept-v2')
  const r = await deliver(f)
  assert.equal(r.status, 'passed')
  assert.equal(r.steps['web-build'].execution, 'reused'); assert.ok(!f.calls.includes('web-build'))
  assert.ok(f.calls.includes('web-test'), 'acceptance re-runs')
  assert.equal(r.buildInputsHash, r0.buildInputsHash)
  assert.notEqual(r.testInputsHash, r0.testInputsHash)
  assert.equal(r.steps['web-build'].key, r0.steps['web-build'].key)
  assert.equal(r.steps['web-build'].outputHash, r0.steps['web-build'].outputHash, 'same artifact, not a rebuild that should be identical')
})

test('PAIR (b): editing one buildInput re-runs the build and moves only buildInputsHash', async t => {
  const f = await fixture(t); const r0 = await deliver(f)
  f.calls.length = 0
  await edit(f, 'web/a.js', 'web-v2')
  const r = await deliver(f)
  assert.equal(r.steps['web-build'].execution, 'ran'); assert.ok(f.calls.includes('web-build'))
  assert.notEqual(r.buildInputsHash, r0.buildInputsHash)
  assert.equal(r.testInputsHash, r0.testInputsHash)
})

test('FAIL-SAFE (c): a file in no list counts as a buildInput — a new unlisted file rebuilds', async t => {
  const f = await fixture(t); await deliver(f)
  await mkdir(join(f.root, 'brand-new')); await edit(f, 'brand-new/data.json', '{}')
  assert.equal((await deliver(f)).steps['web-build'].execution, 'ran')
})

test('FAIL-SAFE (d): a lockfile is a buildInput even when testInputs would match it', async t => {
  const f = await fixture(t); f.config.testInputs = ['**']; await deliver(f)
  await edit(f, 'package-lock.json', 'lock-v2')
  assert.equal((await deliver(f)).steps['web-build'].execution, 'ran')
})

test('a step with an explicit narrow inputs list also ignores testInputs inside it', async t => {
  const f = await fixture(t); f.config.testInputs = ['web/**/*.spec.js']
  f.config.steps.find(s => s.id === 'web-build').inputs = ['web/**']
  await edit(f, 'web/a.spec.js', 's1'); await deliver(f)
  await edit(f, 'web/a.spec.js', 's2')
  assert.equal((await deliver(f)).steps['web-build'].execution, 'reused')
})

test('acceptance steps key on build + test inputs: a test edit changes their key', async t => {
  const f = await fixture(t)
  f.config.steps.find(s => s.id === 'web-test').inputs = ['**']
  const r0 = await deliver(f); await edit(f, 'SHIPS.md', 'ships-v2'); const r = await deliver(f)
  assert.notEqual(r.steps['web-test'].key, r0.steps['web-test'].key)
})

test('default (no testInputs): build key equals the pre-feature key and a test-file edit still rebuilds', async t => {
  const f = await fixture(t); delete f.config.testInputs
  const digest = v => createHash('sha256').update(v).digest('hex')
  const json = v => JSON.stringify(v, (_k, x) => typeof x === 'function' ? x.toString() : x)
  const r0 = await deliver(f)
  const preflightKey = digest(json(f.config.steps.find(s => s.id === 'preflight')))
  const legacy = await inputFingerprint(f.root, ['**'], { step: f.config.steps.find(s => s.id === 'web-build'), deps: [preflightKey], runtime: process.version, context: {} })
  assert.equal(r0.steps['web-build'].key, legacy, 'unchanged keys: existing consumers keep their cache')
  assert.equal(r0.testInputsHash, digest(''), 'no test inputs configured: the test side is empty')
  await edit(f, 'SHIPS.md', 'ships-v2')
  assert.equal((await deliver(f)).steps['web-build'].execution, 'ran')
})

test('changing the classification rules invalidates old receipts', async t => {
  const f = await fixture(t); await deliver(f)
  f.config.testInputs = ['SHIPS.md']
  assert.equal((await deliver(f)).steps['web-build'].execution, 'ran')
})

test('identity pin: reuse needs the SAME artifact identity; a moved, failing or empty probe runs the build', async t => {
  const f = await fixture(t)
  const web = f.config.steps.find(s => s.id === 'web-build'); delete web.outputs; web.identity = ['probe', 'web']
  let observed = 'sha256:aaa', mode = 'ok'
  const identify = async () => { if (mode === 'throw') throw Error('registry down'); return mode === 'empty' ? '' : observed }
  const r0 = await deliver({ ...f, identify }); assert.equal(r0.steps['web-build'].artifact, 'sha256:aaa')
  let n = 0
  const touch = () => edit(f, 'SHIPS.md', 'ships-' + ++n)
  await touch()
  let r = await deliver({ ...f, identify })
  assert.equal(r.steps['web-build'].execution, 'reused'); assert.equal(r.steps['web-build'].artifact, 'sha256:aaa')
  observed = 'sha256:bbb'; await touch()
  r = await deliver({ ...f, identify })
  assert.equal(r.steps['web-build'].execution, 'ran', 'identity moved: not the pinned artifact'); assert.equal(r.steps['web-build'].artifact, 'sha256:bbb')
  for (const bad of ['throw', 'empty']) {
    mode = bad; await touch(); f.calls.length = 0; r = await deliver({ ...f, identify })
    assert.ok(f.calls.includes('web-build'), 'unverifiable pin must run the build: ' + bad)
    assert.notEqual(r.steps['web-build'].execution, 'reused')
    assert.equal(r.steps['web-build'].status, 'fail', 'and a build that yields no observable identity is not a pass')
    mode = 'ok'; await touch(); await deliver({ ...f, identify }) // re-pin with a good probe
  }
})

test('a reusable step with neither outputs nor identity has nothing pinning it: it runs', async t => {
  const f = await fixture(t); delete f.config.steps.find(s => s.id === 'web-build').outputs
  await deliver(f); await edit(f, 'SHIPS.md', 'ships-v2')
  assert.equal((await deliver(f)).steps['web-build'].execution, 'ran')
})

// The last step matters: there is no later step whose pre-check can accidentally
// hide a missing publication check. Use a real identity subprocess, not a stub.
for (const path of ['fresh', 'reuse', 'reuse-mismatch', 'reuse-error']) {
  test(`source freeze covers the final identity observation (${path}) before receipts or baseline are published`, async t => {
    const f = await fixture(t)
    const web = f.config.steps.find(s => s.id === 'web-build')
    web.after = []
    web.identity = [process.execPath, '-e', `
      const fs = require('node:fs');
      if (fs.existsSync('.vibeubi/mutate')) {
        fs.writeFileSync('web/a.js', 'changed-during-observation');
        if (${JSON.stringify(path)} === 'reuse-error') process.exit(1);
        if (${JSON.stringify(path)} === 'reuse-mismatch') { console.log('different'); process.exit(0); }
      }
      console.log('artifact-a');
    `]
    f.config.steps = [web]
    f.config.features[0].steps = [web.id]
    const home = join(f.root, '.vibeubi/delivery')
    const baseline = () => readFile(join(home, 'baseline.json'), 'utf8').catch(e => { if (e.code === 'ENOENT') return null; throw e })
    const receipts = async () => Promise.all((await readdir(join(home, 'cache'))).sort().map(async name => [name, await readFile(join(home, 'cache', name), 'utf8')]))
    let previousReceipts = []
    if (path !== 'fresh') {
      const first = await deliver(f)
      assert.equal(first.status, 'passed')
      assert.equal(first.steps[web.id].execution, 'ran')
      const second = await deliver(f)
      assert.equal(second.status, 'passed')
      assert.equal(second.steps[web.id].execution, 'reused', 'unchanged source and artifact are a valid reuse')
      previousReceipts = await receipts()
    }
    const previousBaseline = await baseline()
    await mkdir(join(f.root, '.vibeubi'), { recursive: true })
    await writeFile(join(f.root, '.vibeubi/mutate'), 'yes')
    f.calls.length = 0
    const result = await deliver(f)
    assert.equal(result.status, 'failed')
    assert.equal(result.steps[web.id].status, 'fail')
    assert.match(result.steps[web.id].reason, /Source changed/)
    assert.deepEqual(await receipts(), previousReceipts, 'invalid observation must not publish or replace a receipt')
    assert.equal(await baseline(), previousBaseline, 'invalid observation must not advance the baseline')
    if (path !== 'fresh') assert.deepEqual(f.calls, [], 'a changed source must not fall back into a build with stale inputs')
    await rm(join(f.root, '.vibeubi/mutate'))
    await edit(f, 'web/a.js', 'web-v1')
    const restored = await deliver(f)
    assert.equal(restored.status, 'passed')
    assert.equal(restored.steps[web.id].execution, path === 'fresh' ? 'ran' : 'reused')
  })
}

test('source freeze is checked again before final success, after the last step checkpoint', async t => {
  const f = await fixture(t)
  const result = await deliver({ ...f, emit: ({ kind, report }) => {
    if (kind === 'status' && report.status === 'running' && report.steps['web-test']?.status === 'pass') {
      execFileSync(process.execPath, ['-e', "require('fs').writeFileSync('web/a.js','changed-after-checkpoint')"], { cwd: f.root })
    }
  } })
  assert.equal(result.status, 'failed')
  assert.match(result.error, /Source changed/)
  await assert.rejects(readFile(join(f.root, '.vibeubi/delivery/baseline.json')), { code: 'ENOENT' })
})
