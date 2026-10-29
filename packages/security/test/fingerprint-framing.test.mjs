import test from 'node:test'
import assert from 'node:assert/strict'
import { fingerprint } from '../src/rules.mjs'
import { baselineDiff } from '../../kernel/src/index.mjs'

test('finding fingerprints distinguish location and evidence field boundaries', () => {
  // A pipe is legal in a path and evidence. Delimiter concatenation maps these
  // different findings to exactly the same string before hashing.
  const a = ['S0.example', 'src/a|b', 'c']
  const b = ['S0.example', 'src/a', 'b|c']
  assert.equal(a.join('|'), b.join('|'))
  const old = { fingerprint: fingerprint(...a), severity: 'high' }
  const current = { fingerprint: fingerprint(...b), severity: 'high' }
  assert.deepEqual(baselineDiff([old], [old]).known, [old], 'the same finding retains legitimate baseline recognition')
  const diff = baselineDiff([current], [old])
  assert.equal(diff.known.length, 0, 'a distinct finding must not inherit baseline admission')
  assert.deepEqual(diff.new, [current])
  assert.deepEqual(diff.blocking, [current])
  assert.notEqual(fingerprint(...a), fingerprint(...b))
})

test('finding framing preserves intended whitespace and date normalization', () => {
  const a = fingerprint('S0.example', 'src/雪', 'observed 2026-10-29\n  value')
  assert.equal(a, fingerprint('S0.example', 'src/雪', 'observed 2026-10-30 value'))
  assert.notEqual(a, fingerprint('S0.example', 'src/雪', 'observed 2026-10-30 different'))
})
