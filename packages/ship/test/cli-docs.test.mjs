/**
 * The CLI's own listings must not drift from the CLI.
 *
 * `README.md` and `docs/INIT.md` once said adopt/ship/rollback were "not written
 * yet" while they were, and `help` omitted three commands that existed. Both
 * lists are now checked against the command table in bin/vibeubi.mjs.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripAnsi } from '../../kernel/src/index.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const source = await readFile(join(ROOT, 'bin/vibeubi.mjs'), 'utf8')
const commands = [...source.matchAll(/^  (?:async )?(?:"([a-z-]+)"|([a-z]+))\(\) \{/gm)].map(m => m[1] ?? m[2])

test('the command table was actually found (a vacuous list proves nothing)', () => {
  assert.ok(commands.length >= 16, commands.join(','))
  for (const c of ['adopt', 'ship', 'rollback', 'checklist', 'deliver', 'status', 'find', 'probe', 'diagnose', 'coverage-gap']) assert.ok(commands.includes(c), c)
})

test('`help` lists every command', () => {
  const help = stripAnsi(execFileSync(process.execPath, [join(ROOT, 'bin/vibeubi.mjs'), 'help'], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, FORCE_COLOR: '3' } }))
  const missing = commands.filter(c => c !== 'help' && !new RegExp(`^  ${c}\\b`, 'm').test(help))
  assert.deepEqual(missing, [], 'commands that exist but `help` does not list')
})

for (const file of ['README.md', 'docs/INIT.md']) {
  test(`${file}: its implemented-commands list names every command and none that does not exist`, async () => {
    const text = await readFile(join(ROOT, file), 'utf8')
    // The list is the fenced block made only of command names that contains `init` and `orphans`.
    const block = [...text.matchAll(/```\n((?:[a-z·\s-]+\n)+)```/g)].map(m => m[1]).find(b => /\binit\b/.test(b) && /\borphans\b/.test(b)) ?? ''
    const listed = block.split(/[·\s]+/).filter(Boolean)
    assert.ok(listed.length > 10, `could not find the list in ${file}`)
    assert.deepEqual(commands.filter(c => !listed.includes(c)), [], 'implemented but not listed')
    assert.deepEqual(listed.filter(c => !commands.includes(c)), [], 'listed but not implemented')
  })
}
