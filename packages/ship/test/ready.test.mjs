/**
 * The readiness wait is the one place in this pipeline where retrying is
 * allowed, so it is the one place that has to prove it retries the OBSERVATION
 * and not the VERDICT. Every test below exists to pin that line.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { readyObservation } from "../src/run.mjs"
import { deployProof } from "../../kernel/src/index.mjs"

const clock = (startAt = 0) => { let t = startAt; return { now: () => t, sleep: async (ms) => { t += ms } } }
const cfg = { base: "http://x" }

test("waits through a service that is still booting, then proves", async () => {
  let n = 0
  const target = { proof: async ({ expected, previous }) => {
    if (++n < 5) throw new Error("connect ECONNREFUSED 127.0.0.1:3000")
    return { expected, previous, observed: `{"commit":"${expected}"}` }
  } }
  const c = clock()
  const obs = await readyObservation({ target, config: cfg, expected: "new1", previous: "old0", ...c })
  assert.equal(deployProof(obs).ok, true)
  assert.equal(n, 5)
})

test("gives up at the deadline and keeps WHY it could not look", async () => {
  const target = { proof: async () => { throw new Error("connect ECONNREFUSED 127.0.0.1:3000") } }
  const c = clock()
  const obs = await readyObservation({ target, config: cfg, expected: "new1", previous: "old0", readyMs: 1000, ...c })
  const v = deployProof(obs)
  assert.equal(v.ok, false)
  assert.match(v.reason, /could not be reached from outside.*ECONNREFUSED/)
})

test("waiting cannot turn a red into a green: a swap that never took still fails", async () => {
  // The old process holds the port forever — exactly the failure this product
  // is named after. Waiting must not launder it into a pass.
  const target = { proof: async ({ expected, previous }) => ({ expected, previous, observed: `{"commit":"${previous}"}` }) }
  const c = clock()
  const obs = await readyObservation({ target, config: cfg, expected: "new1", previous: "old0", readyMs: 5000, ...c })
  const v = deployProof(obs)
  assert.equal(v.ok, false)
  assert.match(v.reason, /still serving the PREVIOUS build \(old0\)/)
})

test("waiting cannot launder a vacuous proof either", async () => {
  const target = { proof: async ({ expected, previous }) => ({ expected, previous, observed: `{"commit":"${expected}"}` }) }
  const c = clock()
  const obs = await readyObservation({ target, config: cfg, expected: "same", previous: "same", readyMs: 5000, ...c })
  assert.equal(deployProof(obs).ok, false)
})

test("a service that is ready immediately is not delayed at all", async () => {
  let calls = 0
  const target = { proof: async ({ expected, previous }) => { calls++; return { expected, previous, observed: expected } } }
  const c = clock()
  await readyObservation({ target, config: cfg, expected: "new1", previous: "old0", ...c })
  assert.equal(calls, 1)
  assert.equal(c.now(), 0, "no sleeping happened")
})

test("the wait is bounded — it cannot run past its deadline", async () => {
  const target = { proof: async () => { throw new Error("down") } }
  const c = clock()
  await readyObservation({ target, config: cfg, expected: "new1", previous: "old0", readyMs: 3000, ...c })
  assert.ok(c.now() <= 3000 + 250, `stopped at ${c.now()}ms`)
})

test("readyMs is configurable per project", async () => {
  const target = { proof: async () => { throw new Error("down") } }
  const c = clock()
  await readyObservation({ target, config: { ...cfg, proveReadyMs: 800 }, expected: "a", previous: "b", ...c })
  assert.ok(c.now() <= 800 + 250)
})
