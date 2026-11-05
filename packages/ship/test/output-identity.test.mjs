/**
 * The output identity is a PUBLIC contract (`vibeubi/delivery`), not an
 * implementation detail a consumer should re-derive.
 *
 * A consumer once copied the old `sha256(file \0 mode \0 bytes)` recipe to
 * verify a native artifact against a delivery row. When the path encoding
 * moved to `vibeubi-paths-v2` that copy silently disagreed with the row, and
 * every promotion was refused. The remedy is one exported function the
 * consumer imports, pinned here against an INDEPENDENT model of the encoding
 * so that moving the encoding again is a deliberate, test-visible act.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, readFile, lstat, chmod, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import * as delivery from '../src/delivery.mjs'

const { deliver, outputIdentityOf, fileOutputIdentity, OUTPUT_HASH_VERSION } = delivery

// Independent model: records are `kind \0 byteLength \0 payload`, after a version prefix.
const model = records => {
  const h = createHash('sha256').update('vibeubi-paths-v2\0')
  for (const [kind, payload = ''] of records) {
    const b = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload))
    h.update(kind + '\0' + b.length + '\0'); h.update(b)
  }
  return h.digest('hex')
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'ubi-output-identity-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, '.gitignore'), '.vibeubi/\ndist/\n'); await writeFile(join(root, 'src.txt'), 'source')
  const git = args => execFileSync('git', args, { cwd: root, stdio: 'pipe' }).toString().trim()
  git(['init']); git(['add', '.']); git(['-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-m', 'x'])
  const build = async outputs => deliver({ root, config: { recordBaseline: false,
    features: [{ id: 'f', covers: ['**'], steps: ['build'], always: true }],
    steps: [{ id: 'build', phase: 'build', always: true, outputs }] },
  execute: async () => {
    await mkdir(join(root, 'dist/tree'), { recursive: true })
    await writeFile(join(root, 'dist/daemon'), Buffer.from([0, 1, 2, 255, 0, 10])); await chmod(join(root, 'dist/daemon'), 0o755)
    await writeFile(join(root, 'dist/tree/a'), 'a'); await writeFile(join(root, 'dist/tree/b'), 'b')
    await symlink('a', join(root, 'dist/tree/link')).catch(() => {})
    return { ok: true }
  } })
  return { root, build }
}

test('the identity API is exported, and its version is the encoding the rows use', () => {
  assert.equal(typeof outputIdentityOf, 'function')
  assert.equal(typeof fileOutputIdentity, 'function')
  assert.equal(OUTPUT_HASH_VERSION, 'vibeubi-paths-v2')
})

test('fileOutputIdentity equals the delivery row\'s outputHash for a real single-file output', async t => {
  const f = await fixture(t)
  const r = await f.build(['dist/daemon'])
  assert.equal(r.status, 'passed')
  const bytes = await readFile(join(f.root, 'dist/daemon')), mode = (await lstat(join(f.root, 'dist/daemon'))).mode
  const id = fileOutputIdentity({ path: 'dist/daemon', mode, bytes })
  assert.equal(id, r.steps.build.outputHash)
  assert.equal(id, model([['path', 'dist/daemon'], ['mode', mode], ['file', bytes]]), 'pinned against the independent model')
})

test('fileOutputIdentity is falsifiable: bytes, mode and path each change it', async t => {
  const f = await fixture(t)
  const bytes = await readFile(join(f.root, 'src.txt')), mode = 0o100644
  const base = fileOutputIdentity({ path: 'dist/x', mode, bytes })
  assert.notEqual(fileOutputIdentity({ path: 'dist/x', mode, bytes: Buffer.from('tampered') }), base)
  assert.notEqual(fileOutputIdentity({ path: 'dist/x', mode: mode ^ 0o100, bytes }), base)
  assert.notEqual(fileOutputIdentity({ path: 'dist/y', mode, bytes }), base)
  // The framing is the point: a path that LOOKS like (path, mode) cannot impersonate the pair.
  assert.notEqual(fileOutputIdentity({ path: 'dist/x\0mode\x003', mode: 1, bytes }), fileOutputIdentity({ path: 'dist/x', mode: 3, bytes }))
})

test('fileOutputIdentity rejects what it cannot frame honestly', () => {
  assert.throws(() => fileOutputIdentity({ path: '', mode: 1, bytes: Buffer.alloc(0) }), /path/)
  assert.throws(() => fileOutputIdentity({ path: 'x', mode: 'rw', bytes: Buffer.alloc(0) }), /mode/)
  assert.throws(() => fileOutputIdentity({ path: 'x', mode: 1, bytes: 'not bytes' }), /bytes/)
  assert.throws(() => fileOutputIdentity(undefined), /path/)
})

test('outputIdentityOf observes the filesystem exactly as deliver() does, for files, directories and links', async t => {
  const f = await fixture(t)
  const r = await f.build(['dist/daemon', 'dist/tree'])
  assert.equal(await outputIdentityOf(f.root, ['dist/daemon', 'dist/tree']), r.steps.build.outputHash)
  assert.equal(await outputIdentityOf(f.root, ['dist/tree', 'dist/daemon', 'dist/tree']), r.steps.build.outputHash, 'order and duplicates do not matter')
  await writeFile(join(f.root, 'dist/tree/b'), 'changed')
  assert.notEqual(await outputIdentityOf(f.root, ['dist/daemon', 'dist/tree']), r.steps.build.outputHash)
})

test('outputIdentityOf is an OUTPUT identity: a missing path is an error, not a hash of "missing"', async t => {
  const f = await fixture(t)
  await assert.rejects(() => outputIdentityOf(f.root, ['dist/never-built']), /ENOENT/)
  await assert.rejects(() => outputIdentityOf(f.root, []), /at least one/)
})

test('outputIdentityOf refuses an output that resolves outside the root (same rule as deliver)', async t => {
  const f = await fixture(t)
  await mkdir(join(f.root, 'dist'), { recursive: true })
  await writeFile(join(f.root, '..', 'outside-' + process.pid), 'x'); t.after(() => rm(join(f.root, '..', 'outside-' + process.pid), { force: true }))
  await symlink(join(f.root, '..', 'outside-' + process.pid), join(f.root, 'dist/escape'))
  await assert.rejects(() => outputIdentityOf(f.root, ['dist/escape']), /resolves outside root/)
})

test('a passing row records which encoding its outputHash uses; a step without outputs does not gain the field', async t => {
  const f = await fixture(t)
  const r = await f.build(['dist/daemon'])
  assert.equal(r.steps.build.outputHashVersion, OUTPUT_HASH_VERSION)
  const none = await deliver({ root: f.root, config: { recordBaseline: false,
    features: [{ id: 'f', covers: ['**'], steps: ['t'], always: true }], steps: [{ id: 't', phase: 'acceptance', always: true }] },
  execute: async () => ({ ok: true }) })
  assert.equal('outputHashVersion' in none.steps.t, false)
  assert.equal(none.steps.t.outputHash, null)
})
