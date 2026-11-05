/**
 * ansi.mjs — read the words, not the paint.
 *
 * Step output is parsed by the kernel (`testRanVerdict`: "did tests run?"). A
 * runner that honours `FORCE_COLOR` (inherited by every step) wraps the exact
 * lines the verdict reads in escape codes, and `# pass 3` becomes
 * `ESC[34m# pass 3ESC[39m`: no longer matching, or, one layer down, a number
 * that parses as NaN. We cannot control every runner's colour policy, so the
 * reader normalises. Zero I/O, like the rest of the kernel.
 */

// CSI: ESC [ params intermediates final   (SGR colours, cursor moves, erases)
// OSC: ESC ] ... terminated by BEL or ST  (titles, hyperlinks)
// Other two-byte ESC sequences (charset selection, keypad modes, reset).
const ANSI = new RegExp(
  [
    "\\u001b\\][^\\u0007\\u001b]*(?:\\u0007|\\u001b\\\\)",
    "\\u001b\\[[0-?]*[ -/]*[@-~]",
    "\\u001b[()][0-9A-Za-z]",
    "\\u001b[@-Z\\\\^_=>78c]",
  ].join("|"),
  "g",
)

/**
 * @param {unknown} text
 * @returns {string} `text` as a string with terminal escape sequences removed.
 *   Nullish input is the empty string, so callers need no guard of their own.
 */
export function stripAnsi(text) {
  return String(text ?? "").replace(ANSI, "")
}
