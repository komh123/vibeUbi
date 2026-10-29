import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { runScan } from '../src/run.mjs'

test('unmatched baseline IDs are not reported as remediated findings during an encoding upgrade', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ubi-baseline-upgrade-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, 'route.js'), 'export function GET() { return "still ungated" }')
  const opts = { root, layers: ['S2'], config: { gateTokens: ['requireAuth'] },
    discovered: [{ kind: 'api', path: '/api/sample', source: 'route.js' }] }
  const fresh = await runScan(opts)
  assert.equal(fresh.findings.length, 1)
  const finding = fresh.findings[0]
  const oldId = createHash('sha256').update(`${finding.rule}|${finding.where}|${finding.evidence}`).digest('hex').slice(0, 32)
  const baseline = [{ fingerprint: oldId }], original = JSON.stringify(baseline)
  const migrated = await runScan({ ...opts, config: { ...opts.config, baseline } })
  assert.equal(migrated.baseline.known, 0)
  assert.equal(migrated.baseline.new, 1)
  assert.equal(migrated.blocking.length, 1)
  assert.equal(migrated.baseline.unmatched, 1)
  assert.equal(Object.hasOwn(migrated.baseline, 'resolved'), false, 'absence of an old ID does not prove remediation')
  assert.equal(JSON.stringify(baseline), original)
  const current = await runScan({ ...opts, config: { ...opts.config, baseline: [{ fingerprint: finding.fingerprint }] } })
  assert.equal(current.baseline.known, 1)
  assert.equal(current.baseline.unmatched, 0)
  assert.deepEqual(current.blocking, [])
})
