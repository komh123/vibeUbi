import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

// Observe the actual crypto input without changing the production encoder or
// exporting a test-only entrypoint. Node isolates this test file in its process.
const realHash = crypto.createHash
let active
crypto.createHash = (...args) => {
  const hash = realHash(...args), update = hash.update.bind(hash), digest = hash.digest.bind(hash)
  const record = { chunks: [] }
  hash.update = (value, encoding) => { if (active) record.chunks.push(Buffer.from(value, encoding)); update(value, encoding); return hash }
  hash.digest = encoding => {
    const result = digest(encoding)
    if (active) active.push({ bytes: Buffer.concat(record.chunks), digest: Buffer.isBuffer(result) ? result.toString('hex') : result })
    return result
  }
  return hash
}
syncBuiltinESMExports()
after(() => { crypto.createHash = realHash; syncBuiltinESMExports() })
const { deliver, inputFingerprint } = await import('../src/delivery.mjs')
const prefix = Buffer.from('vibeubi-paths-v2\0')
const sha = bytes => realHash('sha256').update(bytes).digest('hex')
async function observe(fn) {
  active = []
  try { const result = await fn(); return { result, paths: active.filter(r => r.bytes.subarray(0, prefix.length).equals(prefix)) } }
  finally { active = undefined }
}

// Reference model operates on explicit fixture records, never on production
// output. Its decoder walks lengths with a cursor; it never splits payload bytes.
function encode(records) {
  return Buffer.concat([prefix, ...records.flatMap(([kind, data]) => {
    const payload = Buffer.from(data)
    return [Buffer.from([kind, String(payload.byteLength), ''].join('\0')), payload]
  })])
}
function decode(bytes) {
  assert.ok(bytes.subarray(0, prefix.length).equals(prefix))
  let offset = prefix.length
  const token = () => {
    const end = bytes.indexOf(0, offset); assert.ok(end >= offset, 'unterminated token')
    const value = bytes.toString('ascii', offset, end); offset = end + 1; return value
  }
  const records = []
  while (offset < bytes.length) {
    const kind = token(), decimal = token()
    assert.ok(['path', 'mode', 'file', 'missing', 'link', 'directory', 'end-directory'].includes(kind))
    assert.match(decimal, /^(0|[1-9][0-9]*)$/)
    const size = Number(decimal)
    assert.ok(Number.isSafeInteger(size) && size <= bytes.length - offset, 'truncated field')
    records.push([kind, Buffer.from(bytes.subarray(offset, offset + size))]); offset += size
  }
  return records
}
async function fixture(t) {
  const root = await fs.mkdtemp(join(tmpdir(), 'ubi-reference-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  await fs.mkdir(join(root, 'inputs')); await fs.mkdir(join(root, 'dist'))
  await fs.writeFile(join(root, '.gitignore'), '.vibeubi/\ndist/\n')
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' })
  git('init'); git('add', '.'); git('-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-m', 'fixture')
  return { root, git }
}
const fields = async (root, path, kind, bytes = Buffer.alloc(0)) => [
  ['path', Buffer.from(path)], ['mode', Buffer.from(String((await fs.lstat(join(root, path))).mode))], [kind, bytes],
]

test('32 deterministic binary/Unicode manifests match an independent encoder and decode losslessly', async t => {
  const { root } = await fixture(t)
  const names = ['inputs/a', 'inputs/雪', 'inputs/\ufeff', 'inputs/😀'].sort()
  let state = 0x5eed1234
  const next = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return state >>> 0 }
  const seen = new Set(), patterns = ['inputs/**'], salt = { audit: true }
  for (let iteration = 0; iteration < 32; iteration++) {
    const records = []
    for (const [i, name] of names.entries()) {
      const bytes = Buffer.alloc(i === 0 ? iteration : (next() % 257))
      for (let n = 0; n < bytes.length; n++) bytes[n] = next() & 255
      await fs.writeFile(join(root, name), bytes)
      records.push(...await fields(root, name, 'file', bytes))
    }
    const expected = encode(records)
    const got = await observe(() => inputFingerprint(root, patterns, salt))
    assert.equal(got.paths.length, 1)
    assert.deepEqual(got.paths[0].bytes, expected)
    assert.deepEqual(decode(got.paths[0].bytes), records)
    assert.equal(got.result, sha(sha(expected) + JSON.stringify({ patterns, salt })))
    assert.equal(seen.has(expected.toString('hex')), false); seen.add(expected.toString('hex'))
    assert.throws(() => decode(expected.subarray(0, expected.length - 1)))
  }
})

test('directory and resolved-link records match an explicit output manifest', async t => {
  const { root } = await fixture(t)
  await fs.mkdir(join(root, 'dist/sub'))
  await fs.writeFile(join(root, 'dist/empty'), '')
  await fs.writeFile(join(root, 'dist/sub/item'), Buffer.from([0, 255]))
  await fs.writeFile(join(root, 'dist/target'), '雪')
  await fs.symlink('target', join(root, 'dist/link'))
  const config = { features: [{ id: 'x', covers: ['**'], steps: ['build'] }], steps: [{ id: 'build', outputs: ['dist'] }] }
  const got = await observe(() => deliver({ root, config, execute: async () => ({ ok: true }) }))
  assert.equal(got.result.status, 'passed')
  const records = [
    ...await fields(root, 'dist', 'directory'),
    ...await fields(root, 'dist/empty', 'file'),
    ...await fields(root, 'dist/link', 'link', Buffer.from('target')),
    ...await fields(root, 'dist/target', 'file', Buffer.from('雪')),
    ...await fields(root, 'dist/sub', 'directory'),
    ...await fields(root, 'dist/sub/item', 'file', Buffer.from([0, 255])),
    ['end-directory', Buffer.alloc(0)],
    ...await fields(root, 'dist/target', 'file', Buffer.from('雪')),
    ['end-directory', Buffer.alloc(0)],
  ]
  const expected = encode(records), observed = got.paths.find(r => r.digest === got.result.steps.build.outputHash)
  assert.deepEqual(observed.bytes, expected)
  assert.deepEqual(decode(observed.bytes), records)
  assert.equal(got.result.steps.build.outputHash, sha(expected))
})

test('missing, empty, mode changes and timestamps have distinct declared semantics', async t => {
  const { root, git } = await fixture(t), file = join(root, 'inputs/file')
  await fs.writeFile(file, ''); git('add', 'inputs/file'); await fs.rm(file)
  const missing = await observe(() => inputFingerprint(root, ['inputs/**']))
  assert.deepEqual(decode(missing.paths[0].bytes), [['path', Buffer.from('inputs/file')], ['missing', Buffer.alloc(0)]])
  await fs.writeFile(file, '')
  const empty = await inputFingerprint(root, ['inputs/**'])
  assert.notEqual(empty, missing.result)
  await fs.utimes(file, new Date(0), new Date(0))
  assert.equal(await inputFingerprint(root, ['inputs/**']), empty)
  await fs.chmod(file, 0o700)
  assert.notEqual(await inputFingerprint(root, ['inputs/**']), empty)
})

test('an unreadable source error propagates instead of becoming an empty or missing record', async t => {
  const { root } = await fixture(t), file = join(root, 'inputs/file')
  await fs.writeFile(file, '')
  const read = fs.readFile
  // Controlled I/O failure, because root can read chmod(000) files on Linux.
  fs.readFile = async (...args) => { if (args[0] === file) throw Object.assign(Error('unreadable fixture'), { code: 'EACCES' }); return read(...args) }
  syncBuiltinESMExports()
  try { await assert.rejects(inputFingerprint(root, ['inputs/**']), { code: 'EACCES' }) }
  finally { fs.readFile = read; syncBuiltinESMExports() }
})
