import test from "node:test"
import assert from "node:assert/strict"
import {
  hangVerdict, remediationVerdict, implementationsAgree, countIsNotFitness, populationVerdict, findRule,
} from "../src/index.mjs"

/* ── hangVerdict ──────────────────────────────────────────────────────────── */

test("with no memory reading it says unknown and offers NO theory", () => {
  // The peer specified this test, and it is the whole point of the function:
  // "the failure mode I hit was not 'no diagnosis', it was a confident wrong
  // one, which is strictly worse than silence."
  const r = hangVerdict({ quietForMs: 40 * 60_000, loadAvg1: 6.41, step: '"build"' })
  assert.equal(r.state, "unknown")
  assert.equal(r.known, false)
  for (const theory of [/hang/i, /network/i, /database/i, /container/i, /I\/O/, /waiting on/i, /looks like/i]) {
    assert.ok(!theory.test(r.message), `the unknown message must carry no theory, found ${theory}`)
  }
  // Load average may be echoed, but only to say it settles nothing.
  assert.match(r.message, /distinguishes nothing/)
})

test("their actual build: thrashing, not a hang", () => {
  const r = hangVerdict({
    quietForMs: 40 * 60_000, loadAvg1: 6.41,
    rssGb: 16.7, ceilingGb: 21, swapUsedGbAtStart: 2, swapUsedGb: 20,
    step: '"build"',
  })
  assert.equal(r.state, "thrashing")
  assert.equal(r.known, true)
  assert.equal(r.swapGrowth, 18)
  assert.match(r.message, /not a hang/)
  // The old message said "raising the limit is rarely the fix" and the limit was
  // exactly where the defect was — a 14 GB cache, not the timeout.
  assert.match(r.message, /binding limit/)
  assert.ok(!/network call/i.test(r.message), "must not send them looking for I/O that does not exist")
})

test("load average alone never decides anything", () => {
  // Same load average, opposite verdicts: it is not a discriminator in either
  // direction, because a thrashing process sits in D state and counts toward it.
  const pressure = { rssGb: 16.7, ceilingGb: 21, swapUsedGbAtStart: 2, swapUsedGb: 20 }
  const calm = { rssGb: 2, ceilingGb: 21, swapUsedGbAtStart: 2, swapUsedGb: 2 }
  assert.equal(hangVerdict({ ...pressure, loadAvg1: 6.41 }).state, "thrashing")
  assert.equal(hangVerdict({ ...calm, loadAvg1: 6.41 }).state, "quiet")
  // And the same inputs with load average absent reach the same verdicts.
  assert.equal(hangVerdict(pressure).state, "thrashing")
  assert.equal(hangVerdict(calm).state, "quiet")
})

test("RSS against the ceiling is enough on its own", () => {
  assert.equal(hangVerdict({ rssGb: 16.7, ceilingGb: 21 }).state, "thrashing")
  assert.equal(hangVerdict({ swapUsedGbAtStart: 2, swapUsedGb: 20 }).state, "thrashing")
  // "quiet" is a real finding too — memory ruled out, cause not established.
  assert.match(hangVerdict({ rssGb: 1, ceilingGb: 21 }).message, /has not been established/)
})

/* ── remediationVerdict ───────────────────────────────────────────────────── */

test("an instruction that cannot clear the cause that fired", () => {
  // Their case: a machine configured with a container sandbox structurally
  // cannot issue the authorization, so "update Rabi Local" never helps.
  const bad = remediationVerdict({
    cause: "sandbox-cannot-authorize",
    remediation: "update Rabi Local on this computer",
    resolves: ["version-too-old", "binary-missing"],
  })
  assert.equal(bad.ok, false)
  assert.equal(bad.known, true)
  assert.match(bad.reason, /will do it, it will not help/)

  const good = remediationVerdict({
    cause: "version-too-old",
    remediation: "update Rabi Local on this computer",
    resolves: ["version-too-old", "binary-missing"],
  })
  assert.equal(good.ok, true)
})

test("an undeclared remediation cannot be wrong, which is why it never is", () => {
  const r = remediationVerdict({ cause: "whatever", remediation: "try again" })
  assert.equal(r.ok, false)
  assert.equal(r.known, false)
})

test("offering no remediation is honest, not a finding", () => {
  assert.equal(remediationVerdict({ cause: "unknown-state", remediation: "" }).ok, true)
})

/* ── implementationsAgree ─────────────────────────────────────────────────── */

test("two copies of one rule, and somebody changed one of them", () => {
  const gate = (x) => x.role === "admin" || x.deviceOnly === false
  const report = (x) => x.role === "admin"            // the copy that forgot deviceOnly
  const r = implementationsAgree({
    rule: "deviceOnly",
    implementations: { gate, report },
    cases: [{ role: "user", deviceOnly: false }, { role: "admin", deviceOnly: true }],
  })
  assert.equal(r.ok, false)
  assert.equal(r.disagreements.length, 1)
  assert.match(r.reason, /correct on its own/)
})

test("a case set they agree on proves nothing, and the verdict says so", () => {
  const r = implementationsAgree({
    rule: "deviceOnly",
    implementations: { a: (x) => x.role === "admin", b: (x) => x.role === "admin" },
    cases: [{ role: "admin" }],
  })
  assert.equal(r.ok, true)
  assert.match(r.reason, /property of this case set/)
})

test("two copies and no cases is unknown, not agreement", () => {
  const r = implementationsAgree({ rule: "x", implementations: { a: () => 1, b: () => 2 }, cases: [] })
  assert.equal(r.ok, false)
  assert.equal(r.known, false)
  assert.equal(implementationsAgree({ rule: "x", implementations: { a: () => 1 } }).ok, true)
})

test("a copy that throws is a disagreement, not a crash", () => {
  const r = implementationsAgree({
    rule: "x",
    implementations: { a: () => 1, b: () => { throw new Error("boom") } },
    cases: [null],
  })
  assert.equal(r.ok, false)
  assert.match(r.disagreements[0], /threw: boom/)
})

/* ── countIsNotFitness ────────────────────────────────────────────────────── */

test("a healthy count over an unfit population", () => {
  // Their search backend: results came back, and the results for "台灣電信 NPS"
  // were shopping pages.
  const unexamined = countIsNotFitness({ counted: 24, claim: "the search backend works" })
  assert.equal(unexamined.ok, false)
  assert.equal(unexamined.known, false)
  assert.match(unexamined.reason, /is true and is not evidence/)

  const examined = countIsNotFitness({ counted: 24, checked: 10, fit: 0, claim: "the search backend works" })
  assert.equal(examined.ok, false)
  assert.equal(examined.known, true)
  assert.match(examined.reason, /most convincing wrong answer/)

  assert.equal(countIsNotFitness({ counted: 24, checked: 10, fit: 8 }).ok, true)
})

test("156 listed, 0 connected", () => {
  const r = countIsNotFitness({ counted: 156, checked: 156, fit: 0, claim: "the services are connected" })
  assert.equal(r.ok, false)
  assert.equal(r.known, true)
})

/* ── populationVerdict ────────────────────────────────────────────────────── */

test("right arithmetic, wrong denominator", () => {
  const r = populationVerdict({
    claimAbout: "bots that passed the gate and reached production",
    measured: "bots created in the last 7 days",
    n: 40,
    statistic: "the failure rate",
  })
  assert.equal(r.ok, false)
  assert.equal(r.known, true)
  assert.match(r.reason, /arithmetic is fine/)
  assert.match(r.reason, /no\s+recomputation will reveal/)

  assert.equal(populationVerdict({ claimAbout: "P", measured: "P", n: 40 }).ok, true)
})

test("a figure with no recorded population is unknown, not wrong", () => {
  const r = populationVerdict({ claimAbout: "production bots", measured: "" })
  assert.equal(r.ok, false)
  assert.equal(r.known, false)
})

/* ── and all five are reachable from the sentences they came from ─────────── */

test("each new rule is findable from what a person would have searched", () => {
  const expect = {
    "the error message tells the user to do something that can never help": "remediationVerdict",
    "one rule, two implementations, I changed one of them": "implementationsAgree",
    "the count went up, and the content is irrelevant": "countIsNotFitness",
    "the number is for a population I never measured": "populationVerdict",
    "load average was low so it said the machine was not busy": "hangVerdict",
    "I reported the step green and its own output had errors in it": "testRanVerdict",
  }
  for (const [q, rule] of Object.entries(expect)) {
    const hits = findRule(q)
    assert.ok(hits.length, `no hit for ${JSON.stringify(q)}`)
    assert.equal(hits[0].rule, rule, `${JSON.stringify(q)} → ${hits[0].rule}`)
  }
})
