/**
 * Colour codes must not decide whether tests ran.
 *
 * `FORCE_COLOR=3` is inherited by every step (`runStep` spreads process.env), and
 * a runner that honours it wraps the very lines `testRanVerdict` reads. The
 * verdict was then "nothing ran" for a suite that ran, or a number that parsed
 * as NaN downstream. The fix lives where the output is READ, not where it is
 * produced: we cannot control every runner's colour policy.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { stripAnsi, testRanVerdict } from "../src/index.mjs"

const HERE = dirname(fileURLToPath(import.meta.url))
const ESC = "\x1b"

test("stripAnsi removes SGR, cursor/erase CSI and OSC sequences and nothing else", () => {
  assert.equal(stripAnsi(`${ESC}[34m# pass 3${ESC}[39m`), "# pass 3")
  assert.equal(stripAnsi(`${ESC}[0m${ESC}[1;32m 1 pass${ESC}[0m`), " 1 pass")
  assert.equal(stripAnsi(`${ESC}[2K${ESC}[1G# pass 3`), "# pass 3")
  assert.equal(stripAnsi(`${ESC}[38;2;10;20;30mrgb${ESC}[0m`), "rgb")
  assert.equal(stripAnsi(`${ESC}]8;;https://example.com${ESC}\\link${ESC}]8;;${ESC}\\`), "link")
  assert.equal(stripAnsi(`${ESC}]0;title\x07text`), "text")
  assert.equal(stripAnsi("plain [34m brackets are not escapes"), "plain [34m brackets are not escapes")
  assert.equal(stripAnsi(""), "")
  assert.equal(stripAnsi(undefined), "")
  assert.equal(stripAnsi(null), "")
})

test("testRanVerdict: coloured TAP and plain TAP reach the same verdict (a falsifiable pair)", () => {
  const plain = "# tests 3\n# pass 3\n# fail 0\n"
  const coloured = `${ESC}[34m# tests 3${ESC}[39m\n${ESC}[34m# pass 3${ESC}[39m\n${ESC}[34m# fail 0${ESC}[39m\n`
  assert.deepEqual(testRanVerdict("unit", coloured), testRanVerdict("unit", plain))
  assert.deepEqual(testRanVerdict("unit", coloured), { ok: true, passed: 3 })
})

test("testRanVerdict: colour never manufactures a pass — coloured zero is still zero", () => {
  assert.equal(testRanVerdict("unit", `${ESC}[34m# pass 0${ESC}[39m`).ok, false)
  assert.equal(testRanVerdict("unit", `${ESC}[32m\n${ESC}[39m`).ok, false)
})

test("testRanVerdict: alternates survive colour (vitest, mocha, raw TAP)", () => {
  assert.equal(testRanVerdict("v", `${ESC}[32m 7 tests passed${ESC}[0m`).passed, 7)
  assert.equal(testRanVerdict("m", `${ESC}[92m  4 passing${ESC}[0m (2s)`).passed, 4)
  assert.equal(testRanVerdict("t", `${ESC}[32mok 5 -${ESC}[0m x`).passed, 5)
})

test("recorded FORCE_COLOR=3 output of a Node 24 default reporter is stripped clean", async () => {
  const raw = await readFile(join(HERE, "fixtures/node24-spec-force-color-3.out"), "utf8")
  assert.match(raw, /\x1b\[/, "the fixture must really contain colour codes")
  assert.doesNotMatch(stripAnsi(raw), /\x1b/)
  assert.match(stripAnsi(raw), /^ℹ pass 1$/m)
})

test("a non-TAP reporter's output names the fix instead of only 'nothing ran'", async () => {
  const raw = await readFile(join(HERE, "fixtures/node24-spec-force-color-3.out"), "utf8")
  const v = testRanVerdict("unit", raw)
  assert.equal(v.ok, false)
  assert.match(v.reason, /--test-reporter=tap/)
  // ...but only when that shape is actually present: other failures keep their text.
  assert.doesNotMatch(testRanVerdict("unit", "").reason, /--test-reporter/)
})
