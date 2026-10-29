import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { syncBuiltinESMExports } from 'node:module'

test('64 finding tuples preserve separators and Unicode with independently specified normalization', async () => {
  const original = crypto.createHash, captured = []
  crypto.createHash = (...args) => {
    const hash = original(...args), update = hash.update.bind(hash)
    hash.update = (data, encoding) => { captured.push(Buffer.from(data, encoding)); update(data, encoding); return hash }
    return hash
  }
  syncBuiltinESMExports()
  try {
    const { fingerprint } = await import('../src/rules.mjs')
    const alphabet = ['|', '\0', '\n', '雪', '😀', '"', '\\', '']
    for (let i = 0; i < 64; i++) {
      const rule = `r${alphabet[i % 8]}${i}`, where = `p${alphabet[(i >> 3) % 8]}`
      const evidence = ` \titem-${i} 2026-10-29\n value `
      // Expected normalization is specified by the fixture, not copied regexes.
      const normalized = `item-${i} <date> value`
      const tuple = ['vibeubi-finding-v2', rule, where, normalized]
      const expected = Buffer.from(JSON.stringify(tuple))
      captured.length = 0
      const id = fingerprint(rule, where, evidence)
      assert.deepEqual(captured, [expected])
      assert.deepEqual(JSON.parse(captured[0]), tuple)
      assert.equal(id, original('sha256').update(expected).digest('hex').slice(0, 32))
      assert.equal(id, fingerprint(rule, where, `item-${i} 2026-10-30 value`))
      assert.notEqual(id, fingerprint(rule, where + '|', evidence))
    }
    assert.equal(fingerprint('r', 'p', null), fingerprint('r', 'p', ''))
    assert.equal(fingerprint('r', 'p', undefined), fingerprint('r', 'p', ''))
    assert.notEqual(fingerprint('r', 'p', 'x2026-10-29y'), fingerprint('r', 'p', 'x2026-10-30y'))
    assert.notEqual(fingerprint('r', 'é', ''), fingerprint('r', 'e\u0301', ''))
    assert.notEqual(fingerprint('r', 'p:1', ''), fingerprint('r', 'p:2', ''))
  } finally { crypto.createHash = original; syncBuiltinESMExports() }
})
