/**
 * A proof that satisfies the contract's SHAPE can still identify nothing. The
 * payload that made this necessary, from one real endpoint:
 *
 *     { "commit": null, "buildId": "KGnc5zIqM6jlQ6phpKEz2", ... }
 *
 * Both fields sit behind the same declared `versionPath`, and only one of them
 * can tell a build from another.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { proofDiscrimination, trimProofHistory } from "../src/index.mjs"

const s = (artifactId, observed, at = 0) => ({ artifactId, observed, at })

// Measured across three real deploys of one app.
const A = "bpXmD_3uCBKysribpDArg", B = "KGnc5zIqM6jlQ6phpKEz2"

test("buildId tells builds apart", () => {
  const r = proofDiscrimination([s(A, A, 1), s(B, B, 2)])
  assert.equal(r.ok, true)
  assert.equal(r.verdict, "discriminating")
})

test("`commit: null` is refused — but as UNMEASURED, because null is not an observation", () => {
  // The samples are dropped before the question is asked: a field nobody could
  // read is not evidence of no power, it is evidence of nothing.
  const r = proofDiscrimination([s(A, null, 1), s(B, null, 2)])
  assert.equal(r.ok, false)
  assert.equal(r.verdict, "unmeasured")
})

test("a CONSTANT value is no power — the same answer for every build", () => {
  const r = proofDiscrimination([s(A, "0.1.0", 1), s(B, "0.1.0", 2)])
  assert.equal(r.ok, false)
  assert.equal(r.verdict, "no-power")
  assert.match(r.reason, /same answer for every build is the same answer as no answer/)
})

test("THE TRAP: `loadedAt` changes on every deploy and still cannot see a rollback", () => {
  // It passes direction 1 — every deploy gives a new timestamp. Direction 2 is
  // the only thing that catches it: roll back to A and the process restarts, so
  // the field reports a NEW value for an OLD artifact.
  const history = [s(A, "06:56:44Z", 1), s(B, "08:38:38Z", 2), s(A, "09:10:02Z", 3)]
  const r = proofDiscrimination(history)
  assert.equal(r.ok, false)
  assert.equal(r.verdict, "identifies-something-else")
  assert.match(r.reason, /identifying something else — process start, a clock/)

  // and it really does pass direction 1 on its own, which is why one direction
  // is not enough
  assert.equal(proofDiscrimination(history.slice(0, 2)).ok, true)
})

test("a real rollback with a real id is fine — same artifact, same value", () => {
  const r = proofDiscrimination([s(A, A, 1), s(B, B, 2), s(A, A, 3)])
  assert.equal(r.ok, true)
})

test("one artifact is not enough to ask the question, and that is not a pass", () => {
  const r = proofDiscrimination([s(A, A, 1), s(A, A, 2)])
  assert.equal(r.ok, false)
  assert.equal(r.verdict, "unmeasured")
  assert.match(r.reason, /before the question can be asked/)
})

test("empty strings are not observations either", () => {
  assert.equal(proofDiscrimination([s(A, "", 1), s(B, "  ", 2)]).verdict, "unmeasured")
})

test("trimming keeps the FIRST sighting of every artifact — the rollback evidence", () => {
  // A plain last-N window drops the older sample of an artifact that comes
  // back, which is the only sample direction 2 can use.
  const many = [s(A, A, 1), ...Array.from({ length: 50 }, (_, i) => s(`x${i}`, `x${i}`, i + 2)), s(A, "DRIFTED", 99)]
  const kept = trimProofHistory(many, 40)
  assert.ok(kept.some((k) => k.artifactId === A && k.observed === A), "the first sighting of A must survive")
  assert.equal(proofDiscrimination(kept).verdict, "identifies-something-else",
    "and with it, the drift is still detectable after trimming")
})

test("a short history is returned untouched", () => {
  const short = [s(A, A, 1), s(B, B, 2)]
  assert.deepEqual(trimProofHistory(short, 40), short)
})
