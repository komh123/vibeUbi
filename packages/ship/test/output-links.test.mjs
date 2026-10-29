import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { deliver } from '../src/delivery.mjs'

async function fixture(t, shape = 'file') {
  const home = await mkdtemp(join(tmpdir(), 'ubi-output-links-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const root = join(home, 'repo')
  await mkdir(join(root, 'dist', 'tree'), { recursive: true })
  await mkdir(join(root, 'dist', 'target-dir'))
  await writeFile(join(root, '.gitignore'), '.vibeubi/\ndist/\n')
  await writeFile(join(root, 'source.txt'), 'source')
  await writeFile(join(root, 'dist', 'target'), 'artifact-a')
  await writeFile(join(root, 'dist', 'target-dir', 'item'), 'artifact-a')
  await writeFile(join(home, 'external'), 'artifact-a')
  const link = shape === 'nested' ? 'dist/tree/link' : 'dist/link'
  await symlink(shape === 'nested' ? '../target' : shape === 'directory' ? 'target-dir' : 'target', join(root, link))
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' }).toString().trim()
  git('init'); git('add', '.'); git('-c', 'user.email=test@example.com', '-c', 'user.name=test', 'commit', '-m', 'fixture')
  const config = { features: [{ id: 'app', covers: ['**'], steps: ['build'], always: true }], steps: [
    { id: 'build', phase: 'build', outputs: [shape === 'nested' ? 'dist/tree' : link], reuse: true },
  ] }
  let runs = 0
  const run = () => deliver({ root, config, execute: async () => { runs++; return { ok: true } } })
  const state = async () => {
    const dir = join(root, '.vibeubi', 'delivery')
    const names = await readdir(join(dir, 'cache'))
    return { baseline: await readFile(join(dir, 'baseline.json'), 'utf8').catch(e => { if (e.code === 'ENOENT') return null; throw e }),
      receipts: await Promise.all(names.sort().map(async name => [name, await readFile(join(dir, 'cache', name), 'utf8')])) }
  }
  return { root, home, link, config, run, state, runs: () => runs }
}

for (const shape of ['file', 'nested', 'directory']) {
  test(`output links pin target bytes before reuse (${shape})`, async t => {
    const f = await fixture(t, shape)
    const first = await f.run()
    assert.equal(first.status, 'passed')
    const cached = await f.run()
    assert.equal(cached.steps.build.execution, 'reused')
    assert.equal(f.runs(), 1)
    const target = shape === 'directory' ? 'dist/target-dir/item' : 'dist/target'
    await writeFile(join(f.root, target), 'artifact-b')
    const changed = await f.run()
    assert.equal(changed.status, 'passed')
    assert.equal(changed.steps.build.execution, 'ran', 'changed bytes cannot reuse the old receipt')
    assert.notEqual(changed.steps.build.outputHash, first.steps.build.outputHash)
    assert.equal(f.runs(), 2)
    assert.equal((await f.run()).steps.build.execution, 'reused', 'the newly observed artifact can be reused')
  })
}

for (const mode of ['fresh', 'reuse']) for (const invalid of ['dangling', 'outside', 'cycle']) {
  test(`unobservable output links cannot publish receipts (${mode}, ${invalid})`, async t => {
    const f = await fixture(t)
    if (mode === 'reuse') {
      assert.equal((await f.run()).status, 'passed')
      assert.equal((await f.run()).steps.build.execution, 'reused')
    }
    // Both variants establish the same declared link; only its observability changes.
    if (invalid === 'dangling') await rm(join(f.root, 'dist/target'))
    else {
      await rm(join(f.root, f.link))
      await symlink(invalid === 'outside' ? '../../external' : '.', join(f.root, f.link))
    }
    const before = mode === 'reuse' ? await f.state() : { baseline: null, receipts: [] }
    const result = await f.run()
    assert.equal(result.status, 'failed', 'a link name is not evidence of readable artifact bytes')
    assert.equal(result.steps.build.status, 'fail')
    assert.deepEqual(await f.state(), before, 'unobservable artifacts must not publish or replace valid evidence')
  })
}

test('two output links to the same directory are aliases, not a cycle', async t => {
  const f = await fixture(t, 'nested')
  await symlink('../target-dir', join(f.root, 'dist/tree/one'))
  await symlink('../target-dir', join(f.root, 'dist/tree/two'))
  assert.equal((await f.run()).status, 'passed')
  assert.equal((await f.run()).steps.build.execution, 'reused')
})

for (const mode of ['fresh', 'reuse']) {
  test(`output paths cannot escape through a symlink parent (${mode})`, async t => {
    const f = await fixture(t, 'nested')
    f.config.steps[0].outputs = ['dist/tree/file']
    await writeFile(join(f.root, 'dist/tree/file'), 'artifact-a')
    if (mode === 'reuse') {
      assert.equal((await f.run()).status, 'passed')
      assert.equal((await f.run()).steps.build.execution, 'reused')
    }
    await mkdir(join(f.home, 'external-dir'))
    await writeFile(join(f.home, 'external-dir/file'), 'artifact-a')
    await rm(join(f.root, 'dist/tree'), { recursive: true })
    await symlink('../../external-dir', join(f.root, 'dist/tree'))
    // Declare a regular file under the symlink, rather than the symlink itself.
    // lstat alone sees a file; only its resolved path reveals the escape.
    // Keep the step declaration fixed for both executions in this fixture.
    const before = mode === 'reuse' ? await f.state() : { baseline: null, receipts: [] }
    const result = await f.run()
    assert.equal(result.status, 'failed')
    assert.match(result.steps.build.reason, /outside root/)
    assert.deepEqual(await f.state(), before)
  })
}
