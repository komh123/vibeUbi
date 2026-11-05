/**
 * The default step runner under FORCE_COLOR=3: a suite that printed coloured
 * TAP must still count as having run, and a failure's `reason` (which lands in
 * JSON reports) must be readable text, not escape codes.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { deliver } from '../src/delivery.mjs'

async function run(t, script, env = { FORCE_COLOR: '3' }) {
  const root = await mkdtemp(join(tmpdir(), 'ubi-force-color-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, '.gitignore'), '.vibeubi/\n'); await writeFile(join(root, 'a.txt'), 'a')
  const git = args => execFileSync('git', args, { cwd: root, stdio: 'pipe' }).toString().trim()
  git(['init']); git(['add', '.']); git(['-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-m', 'x'])
  const config = { recordBaseline: false, features: [{ id: 'f', covers: ['**'], steps: ['unit'], always: true }],
    steps: [{ id: 'unit', phase: 'acceptance', always: true, expectsTests: true, env, cmd: [process.execPath, '-e', script] }] }
  return deliver({ root, config })
}
// What a colouring runner prints when FORCE_COLOR is set; plain otherwise.
const coloured = n => `const c=process.env.FORCE_COLOR?['\\x1b[34m','\\x1b[39m']:['',''];console.log(c[0]+'# tests ${n}'+c[1]);console.log(c[0]+'# pass ${n}'+c[1])`

test('FORCE_COLOR=3 and no colour reach the same pass (a falsifiable pair)', async t => {
  const forced = await run(t, coloured(3)), plain = await run(t, coloured(3), {})
  assert.equal(plain.status, 'passed')
  assert.equal(forced.status, 'passed', forced.steps.unit?.reason)
})

test('coloured zero tests is still a failure, and its reason carries no escape codes', async t => {
  const r = await run(t, coloured(0) + ";console.log('\\x1b[31mboom\\x1b[39m');process.exit(0)")
  assert.equal(r.status, 'failed')
  assert.match(r.steps.unit.reason, /nothing in its output says a test ran/)
  const bad = await run(t, "console.error('\\x1b[31mexploded\\x1b[39m');process.exit(3)")
  assert.match(bad.steps.unit.reason, /exit 3 — exploded/)
  assert.doesNotMatch(bad.steps.unit.reason, /\x1b/)
})
