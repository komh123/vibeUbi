import test from 'node:test'
import assert from 'node:assert/strict'
import { countsAsEvidence } from '../src/index.mjs'

test('build evidence needs an expected build fingerprint, not just a test fingerprint or a phase', () => {
  const report = { ok: true, phase: 'build', buildInputsHash: 'build-a', testInputsHash: 'test-a' }
  assert.equal(countsAsEvidence(report, { phase: 'build', buildInputsHash: 'build-a' }).ok, true)
  for (const want of [{ phase: 'build', testInputsHash: 'test-b' }, { phase: 'build' }, {}]) {
    assert.equal(countsAsEvidence(report, want).ok, false, JSON.stringify(want))
  }
  assert.equal(countsAsEvidence({ ok: true, phase: 'build' }, { phase: 'build' }).ok, false)
})

test('fingerprint equality is meaningful only for nonempty strings on both sides', () => {
  for (const field of ['buildInputsHash', 'testInputsHash', 'sourceTree']) {
    for (const value of [undefined, null, '', '  ', 0, false, [], {}]) {
      const report = { ok: true, phase: 'acceptance', buildInputsHash: 'b', testInputsHash: 't', sourceTree: 's' }
      const want = { phase: 'acceptance', buildInputsHash: 'b', testInputsHash: 't', sourceTree: 's' }
      report[field] = want[field] = value
      assert.equal(countsAsEvidence(report, want).ok, false, `${field}: ${JSON.stringify(value)}`)
    }
  }
})

test('build reuse ignores test-only edits; acceptance still binds both halves', () => {
  for (const phase of ['build', 'acceptance']) {
    const report = { ok: true, phase, buildInputsHash: 'b', testInputsHash: 't1' }
    assert.equal(countsAsEvidence(report, { phase, buildInputsHash: 'b', testInputsHash: 't1' }).ok, true)
    assert.equal(countsAsEvidence(report, { phase, buildInputsHash: 'b', testInputsHash: 't2' }).ok, phase === 'build')
    assert.equal(countsAsEvidence(report, { phase, buildInputsHash: 'other', testInputsHash: 't1' }).ok, false)
    assert.equal(countsAsEvidence({ ...report, buildInputsHash: undefined }, { phase, buildInputsHash: 'b', testInputsHash: 't1' }).ok, false)
  }
})

test('a whole-tree binding remains valid, but cannot override a bad explicit split binding', () => {
  const report = { ok: true, phase: 'build', sourceTree: 'tree', buildInputsHash: 'b' }
  assert.equal(countsAsEvidence(report, { phase: 'build', sourceTree: 'tree' }).ok, true)
  assert.equal(countsAsEvidence(report, { phase: 'build', sourceTree: 'other' }).ok, false)
  assert.equal(countsAsEvidence(report, { phase: 'build', sourceTree: 'tree', buildInputsHash: '' }).ok, false)
})

test('matching fingerprints never promote a diagnostic, narrowed or failed run into evidence', () => {
  for (const invalid of [{ kind: 'diagnostic' }, { diagnostic: true }, { evidence: false }, { narrowed: true }, { ok: false }]) {
    const report = { ok: true, phase: 'build', buildInputsHash: 'b', ...invalid }
    assert.equal(countsAsEvidence(report, { phase: 'build', buildInputsHash: 'b' }).ok, false)
  }
})
