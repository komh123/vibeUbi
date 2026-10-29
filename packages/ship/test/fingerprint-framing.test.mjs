import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, lstat, readdir, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { deliver, inputFingerprint } from '../src/delivery.mjs'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'ubi-framing-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'source')); await mkdir(join(root, 'dist'))
  await writeFile(join(root, '.gitignore'), '.vibeubi/\ndist/\n')
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' }).toString().trim()
  git('init')
  const pair = async dir => {
    const names = [`${dir}/a.bin`, `${dir}/b.bin`]
    for (const name of names) await writeFile(join(root, name), '')
    const headers = await Promise.all(names.map(async name => Buffer.from(name + '\0' + (await lstat(join(root, name))).mode + '\0')))
    const tail = Buffer.from('payload\0雪')
    const before = [Buffer.alloc(0), Buffer.concat([headers[1], tail])]
    const after = [headers[1], tail]
    // This proves ambiguity before SHA-256 is involved: two different file
    // vectors produce identical bytes in the old encoding, not a hash collision.
    assert.notDeepEqual(before, after)
    assert.deepEqual(Buffer.concat([headers[0], before[0], headers[1], before[1]]),
      Buffer.concat([headers[0], after[0], headers[1], after[1]]))
    const set = async values => { for (const [i, name] of names.entries()) await writeFile(join(root, name), values[i]) }
    await set(before)
    return { names, change: () => set(after), restore: () => set(before) }
  }
  const source = await pair('source'), outputs = await pair('dist')
  git('add', '.'); git('-c', 'user.email=test@example.com', '-c', 'user.name=test', 'commit', '-m', 'fixture')
  const config = { features: [{ id: 'product', covers: ['**'], steps: ['build'], always: true }], steps: [
    { id: 'build', phase: 'build', inputs: ['source/**'], outputs: outputs.names, reuse: true },
  ] }
  const execute = async () => ({ ok: true })
  const state = async () => {
    const dir = join(root, '.vibeubi/delivery')
    const names = await readdir(join(dir, 'cache'))
    return { baseline: await readFile(join(dir, 'baseline.json'), 'utf8'),
      receipts: await Promise.all(names.sort().map(async name => [name, await readFile(join(dir, 'cache', name), 'utf8')])) }
  }
  return { root, config, source, outputs, git, state, execute }
}

test('input fingerprints distinguish file boundaries even when legacy streams are identical', async t => {
  const f = await fixture(t)
  const before = await inputFingerprint(f.root, ['source/**'])
  const objects = f.git('hash-object', ...f.source.names)
  assert.equal(await inputFingerprint(f.root, ['source/**']), before)
  await f.source.change()
  assert.notEqual(f.git('hash-object', ...f.source.names), objects, 'Git independently observes changed file objects')
  assert.notEqual(await inputFingerprint(f.root, ['source/**']), before)
  await f.source.restore()
  assert.equal(await inputFingerprint(f.root, ['source/**']), before)
})

test('changed file boundaries invalidate reusable build input evidence', async t => {
  const f = await fixture(t)
  const before = await deliver(f)
  assert.equal(before.status, 'passed')
  assert.equal((await deliver(f)).steps.build.execution, 'reused')
  await f.source.change()
  const after = await deliver(f)
  assert.equal(after.steps.build.execution, 'ran')
  assert.notEqual(after.buildInputsHash, before.buildInputsHash)
  assert.notEqual(after.sourceTree, before.sourceTree)
})

for (const mode of ['fresh', 'reuse']) {
  test(`source boundary changes during observation cannot publish evidence (${mode})`, async t => {
    const f = await fixture(t)
    f.config.steps[0].identity = ['observe-artifact']
    const good = { ...f, identify: async () => 'artifact' }
    assert.equal((await deliver(good)).status, 'passed')
    assert.equal((await deliver(good)).steps.build.execution, 'reused')
    const before = await f.state()
    const result = await deliver({ ...good, full: mode === 'fresh', identify: async () => { await f.source.change(); return 'artifact' } })
    assert.equal(result.status, 'failed')
    assert.match(result.steps.build.reason, /Source changed/)
    assert.deepEqual(await f.state(), before)
  })
}

for (const shape of ['files', 'directory', 'linked-directory']) {
  test(`output evidence distinguishes file boundaries (${shape})`, async t => {
    const f = await fixture(t)
    if (shape === 'directory') f.config.steps[0].outputs = ['dist']
    if (shape === 'linked-directory') {
      await symlink('dist', join(f.root, 'artifacts'))
      // Keep the link out of source enumeration while observing its real outputs.
      await writeFile(join(f.root, '.gitignore'), '.vibeubi/\ndist/\nartifacts\n')
      f.config.steps[0].outputs = ['artifacts']
    }
    const before = await deliver(f)
    assert.equal(before.status, 'passed')
    assert.equal((await deliver(f)).steps.build.execution, 'reused')
    await f.outputs.change()
    const after = await deliver(f)
    assert.equal(after.status, 'passed')
    assert.equal(after.steps.build.execution, 'ran')
    assert.notEqual(after.steps.build.outputHash, before.steps.build.outputHash)
    assert.equal((await deliver(f)).steps.build.execution, 'reused')
  })
}
