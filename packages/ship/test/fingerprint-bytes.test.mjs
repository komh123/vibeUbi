import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readlink, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { deliver, inputFingerprint } from '../src/delivery.mjs'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'ubi-byte-contract-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'dist'))
  await writeFile(join(root, '.gitignore'), '.vibeubi/\ndist/\n')
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' })
  git('init'); git('add', '.'); git('-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-m', 'fixture')
  const config = { features: [{ id: 'app', covers: ['**'], steps: ['build'], always: true }],
    steps: [{ id: 'build', outputs: ['dist/artifact'], reuse: true }] }
  const execute = async () => { await writeFile(join(root, 'dist/artifact'), 'artifact'); return { ok: true } }
  return { root, config, execute, git }
}
const rawPath = (root, tail) => Buffer.concat([Buffer.from(root + '/'), Buffer.from(tail)])

test('source link identity preserves distinct non-UTF8 target bytes', async t => {
  const f = await fixture(t), link = join(f.root, 'link')
  await symlink(Buffer.from([0x80]), link)
  const first = await inputFingerprint(f.root, ['link'])
  assert.deepEqual(await readlink(link, { encoding: 'buffer' }), Buffer.from([0x80]))
  await rm(link); await symlink(Buffer.from([0x81]), link)
  assert.notEqual(await inputFingerprint(f.root, ['link']), first)
  await rm(link); await symlink(Buffer.from([0x80]), link)
  assert.equal(await inputFingerprint(f.root, ['link']), first)
})

test('source drift in raw link bytes cannot publish a successful receipt', async t => {
  const f = await fixture(t), link = join(f.root, 'link')
  await symlink(Buffer.from([0x80]), link)
  const r = await deliver({ ...f, execute: async () => {
    await f.execute(); await rm(link); await symlink(Buffer.from([0x81]), link); return { ok: true }
  } })
  assert.equal(r.status, 'failed')
  assert.match(r.steps.build.reason, /Source changed/)
})

test('source names with invalid UTF8 cannot alias a real replacement-character name', async t => {
  const f = await fixture(t)
  await writeFile(join(f.root, '\ufffd'), 'valid name')
  assert.equal((await deliver(f)).status, 'passed')
  await writeFile(rawPath(f.root, [0x80]), 'different file')
  const raw = f.git('ls-files', '--cached', '--others', '--exclude-standard', '-z')
  assert.ok(raw.includes(Buffer.from([0x80, 0])))
  await assert.rejects(inputFingerprint(f.root, ['**']), /UTF-8/)
  assert.equal((await deliver(f)).status, 'failed')
})

test('directory outputs reject undecodable child names instead of reading an alias', async t => {
  const f = await fixture(t)
  await writeFile(join(f.root, 'dist/\ufffd'), 'valid name')
  f.config.steps[0].outputs = ['dist']
  assert.equal((await deliver(f)).status, 'passed')
  await writeFile(rawPath(join(f.root, 'dist'), [0x80]), 'unobserved bytes')
  const r = await deliver(f)
  assert.equal(r.status, 'failed')
  assert.match(r.steps.build.reason, /UTF-8/)
})

test('resolved output links cannot substitute a decoded lookalike target', async t => {
  const f = await fixture(t)
  await writeFile(join(f.root, 'dist/\ufffd'), 'lookalike')
  await writeFile(rawPath(join(f.root, 'dist'), [0x80]), 'real artifact')
  await symlink(Buffer.from([0x80]), join(f.root, 'dist/link'))
  f.config.steps[0].outputs = ['dist/link']
  const r = await deliver(f)
  assert.equal(r.status, 'failed')
  assert.match(r.steps.build.reason, /UTF-8/)
})

test('valid Unicode and a literal replacement character remain valid identities', async t => {
  const f = await fixture(t)
  await writeFile(join(f.root, '\ufeff雪\ufffd'), Buffer.from([0, 0xff, 0x80]))
  const first = await inputFingerprint(f.root, ['**'])
  assert.equal(await inputFingerprint(f.root, ['**']), first)
  await writeFile(join(f.root, '\ufeff雪\ufffd'), Buffer.from([0, 0xff, 0x81]))
  assert.notEqual(await inputFingerprint(f.root, ['**']), first)
})
