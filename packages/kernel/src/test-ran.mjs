/**
 * test-ran.mjs — did that step actually run tests, or is it just exit 0?
 *
 * The same shape bit three times in one day, and all three were green:
 *
 *   · an executable path that did not exist  →  `# pass 0` + exit 0
 *   · a suite that stopped at file 44 of 504 →  everything before it green
 *   · a linter given a formatter that does not exist → exit 2, zero lines of
 *     output, read by a human as "0 problems"
 *
 * Common shape: NO BAD NEWS WAS TAKEN FOR GOOD NEWS.
 *
 * Only applied to steps that DECLARE themselves to be tests. A type-checker
 * and a security scanner print no TAP, and forcing the rule on them just
 * breeds an allow-list.
 */

/** @typedef {{ok:true, passed:number} | {ok:false, reason:string}} TestRanVerdict */

const TAP_PASS = /^# pass (\d+)$/gm
/** Other runners' summary lines, so this is not node:test-only. */
const ALTERNATES = [
  /(\d+) (?:tests? )?passed/i,          // vitest / jest / bun
  /(\d+) passing/i,                      // mocha
  /ok (\d+) -/,                          // raw TAP
]

/**
 * @param {string} step
 * @param {string} output
 * @returns {TestRanVerdict}
 */
export function testRanVerdict(step, output) {
  const text = String(output ?? "")
  const tap = [...text.matchAll(TAP_PASS)].map((m) => Number(m[1]))
  let passed = tap.reduce((a, b) => a + b, 0)

  if (tap.length === 0) {
    for (const re of ALTERNATES) {
      const m = re.exec(text)
      if (m) { passed = Number(m[1]); break }
    }
  }

  if (passed === 0) {
    return {
      ok: false,
      reason:
        `"${step}" exited 0, but nothing in its output says a test ran — it did not verify anything.\n` +
        `      For a test step, "no bad news" is not "good news": zero test files loaded, a missing ` +
        `executable, and a process that hung and was killed all look exactly like this.`,
    }
  }
  return { ok: true, passed }
}
