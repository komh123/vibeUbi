/**
 * A failed row must say where its evidence is.
 *
 * `reason` is the last 1200 characters, which is a pointer to a problem, not
 * the problem. The full output was always on disk (`step-<id>.out`) but a
 * failed row never named it, so after a rollback the person debugging had to
 * guess a run directory. The row now carries `logPath`, persisted in
 * report.json / status.json with the rest of the row.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, isAbsolute } from 'node:path'
import { execFileSync } from 'node:child_process'
import { deliver } from '../src/delivery.mjs'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'ubi-failure-log-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, '.gitignore'), '.vibeubi/\n'); await writeFile(join(root, 'a.txt'), 'a')
  const git = args => execFileSync('git', args, { cwd: root, stdio: 'pipe' }).toString().trim()
  git(['init']); git(['add', '.']); git(['-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-m', 'x'])
  const config = (step, extra = []) => ({ recordBaseline: false, features: [{ id: 'f', covers: ['**'], steps: ['s', ...extra.map(e => e.id)], always: true }],
    steps: [{ id: 's', phase: 'acceptance', always: true, ...step }, ...extra] })
  return { root, config }
}
const node = script => ({ cmd: [process.execPath, '-e', script] })
const big = "console.log('FIRST-LINE-OF-EVIDENCE');for(let i=0;i<400;i++)console.log('padding line '+i);console.error('LAST-LINE')"

test('a failed command row names its full log, and the log holds what the 1200-char reason cannot', async t => {
  const f = await fixture(t)
  const r = await deliver({ root: f.root, config: f.config(node(big + ';process.exit(2)')) })
  const row = r.steps.s
  assert.equal(row.status, 'fail')
  assert.ok(row.logPath && isAbsolute(row.logPath), 'logPath is absolute so it survives a cd')
  assert.ok(row.logPath.startsWith(r.outDir))
  const log = await readFile(row.logPath, 'utf8')
  assert.match(log, /FIRST-LINE-OF-EVIDENCE/)
  assert.doesNotMatch(row.reason, /FIRST-LINE-OF-EVIDENCE/, 'the reason is only the tail; this is why the path matters')
})

test('logPath is persisted in the on-disk report, not only the returned object', async t => {
  const f = await fixture(t)
  const r = await deliver({ root: f.root, config: f.config(node('process.exit(1)')) })
  const disk = JSON.parse(await readFile(join(r.outDir, 'report.json'), 'utf8'))
  const status = JSON.parse(await readFile(join(f.root, '.vibeubi/delivery/status.json'), 'utf8'))
  assert.ok(r.steps.s.logPath)
  assert.equal(disk.steps.s.logPath, r.steps.s.logPath)
  assert.equal(status.steps.s.logPath, r.steps.s.logPath)
})

test('a step that exited 0 but ran no tests also names its log', async t => {
  const f = await fixture(t)
  const r = await deliver({ root: f.root, config: f.config({ ...node("console.log('# pass 0')"), expectsTests: true }) })
  assert.equal(r.steps.s.status, 'fail')
  assert.match(await readFile(r.steps.s.logPath, 'utf8'), /# pass 0/)
})

test('a passing row gains no logPath: only failures carry the new field', async t => {
  const f = await fixture(t)
  const r = await deliver({ root: f.root, config: f.config(node('process.exit(0)')) })
  assert.equal(r.steps.s.status, 'pass')
  assert.equal('logPath' in r.steps.s, false)
})

test('an injected executor can attach its own evidence path, by error or by result', async t => {
  const f = await fixture(t)
  const thrown = await deliver({ root: f.root, config: f.config({}), execute: async () => { throw Object.assign(Error('custom boom'), { logPath: '/elsewhere/a.log' }) } })
  assert.equal(thrown.steps.s.logPath, '/elsewhere/a.log')
  const returned = await deliver({ root: f.root, config: f.config({}), execute: async () => ({ ok: false, log: '/elsewhere/b.log' }) })
  assert.equal(returned.steps.s.status, 'fail')
  assert.equal(returned.steps.s.logPath, '/elsewhere/b.log')
  const bare = await deliver({ root: f.root, config: f.config({}), execute: async () => { throw Error('no path') } })
  assert.equal('logPath' in bare.steps.s, false, 'no evidence path is invented when the executor has none')
})

test('a failure AFTER the command ran (missing pinned output) still points at that command\'s log', async t => {
  const f = await fixture(t)
  const r = await deliver({ root: f.root, config: f.config({ ...node("console.log('built nothing')"), outputs: ['dist/never-written'], reuse: true }) })
  assert.equal(r.steps.s.status, 'fail')
  assert.match(r.steps.s.reason, /ENOENT/)
  assert.match(await readFile(r.steps.s.logPath, 'utf8'), /built nothing/)
})
