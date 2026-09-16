/**
 * canary.mjs — prove each rule can still go red, before trusting it to say green.
 *
 * WHY, from a peer session's e2e harness rather than from theory:
 *
 *   Their approval-card counter lived in a page-init script that set
 *   `window.__cards = { total: 0 }` and THEN called
 *   `new MutationObserver(...).observe(document.documentElement)` — which threw,
 *   because at init time `documentElement` is still null. So `total` was always
 *   readable and always 0, with nothing counting. Nobody was listening for page
 *   errors, so it survived two full rounds of ten-project testing.
 *
 *   A dead counter and a live one that has nothing to count return the same
 *   number. The only thing that told them apart was INJECTING a card and
 *   checking it was counted.
 *
 * A gate is the same object. "No orphans", "no drift", "no findings" are all
 * the answer a working scanner gives on a clean project AND the answer a broken
 * scanner gives on any project. Reading the rule does not distinguish them; a
 * unit test on the rule distinguishes them at build time and says nothing about
 * the wiring that runs today, on this machine, with this config.
 *
 * So: before a run is allowed to report green, each rule is handed a sample it
 * MUST flag. A rule that stays quiet on its own canary has not proved the
 * project is clean — it has proved nothing, and that is a coverage hole, which
 * is already the one thing this pipeline refuses to grade over.
 *
 * The samples are deliberately not realistic secrets: each is a synthetic
 * string chosen to match the rule's own documented shape.
 */
import * as rules from "./rules.mjs"

/** @type {{layer:string, rule:string, run:()=>readonly {rule:string}[]}[]} */
export const CANARIES = [
  {
    layer: "S0",
    rule: "S0.secret.tree",
    run: () => rules.s0Secrets({
      files: [{ path: "canary.js", text: 'const k = "sk-live-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"' }],
    }),
  },
  {
    layer: "S2",
    rule: "S2.route.ungated",
    run: () => rules.s2Routes({
      routes: [{ path: "/__canary__/destroy", methods: ["POST"], body: "", source: "canary.js" }],
      gateTokens: ["verifyToken"],
    }),
  },
  {
    layer: "S2",
    rule: "S2.sink.inner_html",
    /**
     * Note the shape: `lines`, each already lexed into a region — NOT `text`
     * like `s0Secrets` takes. The first version of this canary passed `text`
     * and the rule threw `file.lines is not iterable`, which is the canary
     * earning its place before it ever ran against a project: two rules in one
     * layer take two different input shapes, and nothing else says so.
     */
    run: () => rules.s2Sinks({
      files: [{ path: "canary.js", lines: [{ n: 1, region: "code", text: "el.innerHTML = `<b>${userInput}</b>`" }] }],
    }),
  },
  {
    layer: "S4",
    rule: "S4.exposure.orphan",
    run: () => rules.s4Exposure({
      listeners: [{ service: "__canary__", bind: "0.0.0.0", port: 65_000, process: "canary" }],
      declared: [],
    }),
  },
]

/**
 * Run every canary for the requested layers.
 *
 * @returns {{ok:boolean, checked:string[], dead:{layer:string, rule:string, why:string}[]}}
 *   `dead` entries are scanners that could not be shown to work. They are not
 *   findings about the project — they are findings about the scan, and they
 *   belong in `skipped` so the existing coverage machinery withholds the grade
 *   and blocks, rather than in the findings list where they would read as the
 *   project's problem.
 */
export function runCanaries(layers = []) {
  const wanted = CANARIES.filter((c) => layers.includes(c.layer))
  const dead = []
  const checked = []
  for (const c of wanted) {
    let out = []
    try {
      out = c.run() ?? []
    } catch (err) {
      dead.push({ layer: c.layer, rule: c.rule, why: `the rule threw on its own sample: ${err.message}` })
      continue
    }
    if (!out.some((f) => f.rule === c.rule)) {
      dead.push({
        layer: c.layer,
        rule: c.rule,
        // Said at length on purpose: the tempting reading of a silent canary is
        // "the canary is out of date", and acting on that reading deletes the
        // only thing that would have caught a dead scanner.
        why:
          `it did not flag a sample built to match its own documented shape. ` +
          `Either the rule stopped matching, or the sample stopped being an example of it — ` +
          `and until that is settled this rule's silence on the real project means nothing.`,
      })
      continue
    }
    checked.push(c.rule)
  }
  return { ok: dead.length === 0, checked, dead }
}
