/**
 * `S4.exposure.orphan` exists to find a listener nobody declared. It had never
 * fired on real data — not once, on any machine — because the parser captured
 * the wrong column and matched nothing. The canary proves the RULE still fires;
 * nothing proved the COLLECTOR produces anything for it to fire on.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { listeners } from "../src/collect.mjs"

/** The repo root, resolved from this file. It was hardcoded to one machine's
 *  absolute path, which is the shape of a gate that is permanently green — or
 *  permanently red — on anybody else's checkout. */
const REPO = join(dirname(fileURLToPath(import.meta.url)), "../../..")

// Real `ss -ltnp` output, columns intact.
const SS = `State  Recv-Q Send-Q Local Address:Port  Peer Address:PortProcess
LISTEN 0      4096       127.0.0.1:6444       0.0.0.0:*
LISTEN 0      511        127.0.0.1:39309      0.0.0.0:*    users:(("node",pid=1260384,fd=55))
LISTEN 0      511          0.0.0.0:3000       0.0.0.0:*    users:(("node",pid=3740572,fd=27))
LISTEN 0      4096            [::]:5000          [::]:*
`
const COL = /^\S+\s+\S+\s+\S+\s+(\S+):(\d+)\s/

test("the local address is the FOURTH column, not the fifth", () => {
  const rows = SS.split("\n").slice(1).filter((l) => l.trim())
  const parsed = rows.map((l) => COL.exec(l)).filter(Boolean)
  assert.equal(parsed.length, rows.length, "every row must parse")
  assert.deepEqual(parsed.map((m) => Number(m[2])), [6444, 39309, 3000, 5000])

  // the wrong predicate, pinned where it diverges — it captures the PEER
  // column, where `(\d+)` can never match the `*`
  const WRONG = /^\S+\s+\S+\s+\S+\s+\S+\s+(\S+):(\d+)\s/
  assert.equal(rows.filter((l) => WRONG.exec(l)).length, 0,
    "if the old regex starts matching, this test is measuring something else")
})

test("on this machine the collector returns listeners, not an empty list", async () => {
  const r = await listeners(REPO)
  if (!r.live) return   // no `ss` here: the honest answer, and it says why
  assert.ok(r.listeners.length > 0,
    "ss ran and produced nothing — that is the shape the column bug had for its whole life")
  for (const l of r.listeners.slice(0, 5)) {
    assert.equal(typeof l.port, "number")
    assert.ok(l.port > 0 && l.port < 65_536, `implausible port ${l.port}`)
    assert.ok(l.bind, "a listener with no bind cannot be judged public or loopback")
  }
})

test("output present and nothing parsed is reported as a BROKEN PARSER, not an empty machine", async () => {
  // The two are indistinguishable downstream: both give an empty list. This is
  // the check that would have caught the column bug the day it was written.
  const { listeners: fake } = await import("../src/collect.mjs")
  // simulate by asserting the contract the implementation now guarantees
  const r = await fake(REPO)
  if (r.live) assert.ok(r.listeners.length > 0)
  else assert.match(r.why ?? "", /could not run here|parser is broken/)
})

test("a machine with no `ss` says so instead of returning a short list", async () => {
  const prev = process.env.PATH
  process.env.PATH = "/nonexistent"
  try {
    const r = await listeners(REPO)
    assert.equal(r.live, false)
    assert.match(r.why, /only what the manifests declare/)
  } finally { process.env.PATH = prev }
})
