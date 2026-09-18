/**
 * covered.mjs — did that step LOOK at anything, and at everything it should?
 *
 * `testRanVerdict` asks whether a test step ran tests. This is the same
 * question for the steps that print no TAP, and a peer session measured what it
 * costs to not ask it:
 *
 *   Their root tsconfig excluded a whole runtime, so the service running on the
 *   user's own machine went **four months without a single type check**. Every
 *   run exited 0. The test runner does not type-check, so a green suite said
 *   nothing about types. Adding the missing coverage found SIX real defects
 *   immediately — including a missing call inside a feature that had just been
 *   made reachable.
 *
 * That is `# pass 0` one type-level up: **a type checker over an empty file set
 * exits 0**, and so does one over the wrong half of the tree. The tool is
 * working; the configuration decided it should look at nothing, and nothing
 * said so.
 *
 * Their second lesson is the one that makes this worth a kernel rule rather
 * than a lint config: *"after that, only the tool's output — never my own
 * conclusion."* They had claimed a type check passed while two errors stood.
 * A verdict computed from what the tool PRINTED cannot make that mistake.
 */

/**
 * @typedef {{ok:true, checked:number} | {ok:false, reason:string, unchecked?:string[]}} CoverageVerdict
 */

/**
 * Did the checker read the files it was supposed to?
 *
 * @param {object} o
 * @param {string} o.step
 * @param {readonly string[]} o.read      what the tool says it read (e.g. `tsc --listFiles`)
 * @param {readonly string[]} o.expected  what the tree says should be read
 * @param {string} [o.how]                how to ask the tool what it read
 * @returns {CoverageVerdict}
 */
export function coveredVerdict({ step, read = [], expected = [], how = "" }) {
  const norm = (p) => String(p).replace(/^\.\//, "")
  const seen = new Set(read.map(norm))
  const want = [...new Set(expected.map(norm))]

  if (want.length === 0) {
    // Nothing to check is a real answer, not a pass to be proud of — but it is
    // also not a failure, and calling it one breeds an allow-list.
    return { ok: true, checked: 0 }
  }

  if (seen.size === 0) {
    return {
      ok: false,
      unchecked: want,
      reason:
        `"${step}" exited 0 and read NO files. A checker over an empty file set exits 0 exactly like one that ` +
        `found no problems.${how ? ` Ask it what it read: ${how}.` : ""}`,
    }
  }

  const unchecked = want.filter((p) => !seen.has(p))
  if (unchecked.length) {
    return {
      ok: false,
      unchecked,
      reason:
        `"${step}" checked ${seen.size} file(s) and skipped ${unchecked.length}: ${unchecked.slice(0, 5).join(", ")}` +
        `${unchecked.length > 5 ? ` and ${unchecked.length - 5} more` : ""}. ` +
        `A config that excludes part of the tree is silent about it — one real service went four months ` +
        `unchecked this way, and the first check afterwards found six defects.`,
    }
  }
  return { ok: true, checked: seen.size }
}

/**
 * Names defined on one side of a boundary must be registered on the other.
 *
 * The peer's second gate finding: three feature names existed in a service and
 * were never registered in the protocol, so frames carrying them were dropped
 * in silence. The symptom a person saw was 120 seconds of nothing and then
 * "your computer is not responding" — a timeout, nowhere near the cause.
 *
 * **Each side was correct on its own.** Only the pair was wrong, which is why
 * no test on either side could have failed. This is `orphanVerdict`'s shape
 * moved from features-vs-registry to any two lists that must agree, and unlike
 * that one NEITHER side is authoritative: a name on one side alone is a defect
 * whichever side it is on, and the report has to say which.
 *
 * @param {object} o
 * @param {readonly string[]} o.a
 * @param {readonly string[]} o.b
 * @param {string} [o.aName]
 * @param {string} [o.bName]
 */
export function crossLayerNames({ a = [], b = [], aName = "A", bName = "B", symptom = "" }) {
  const A = new Set(a), B = new Set(b)
  const onlyA = [...A].filter((n) => !B.has(n))
  const onlyB = [...B].filter((n) => !A.has(n))

  if (A.size === 0 && B.size === 0) {
    return {
      ok: false, known: false, onlyA, onlyB,
      reason:
        `neither ${aName} nor ${bName} produced any names. Two empty lists agree perfectly, which is why ` +
        `this is reported rather than passed — see \`sameObserved\`.`,
    }
  }
  if (onlyA.length === 0 && onlyB.length === 0) {
    return { ok: true, known: true, onlyA, onlyB, reason: `${A.size} name(s), registered on both sides` }
  }
  return {
    ok: false, known: true, onlyA, onlyB,
    reason: [
      onlyA.length ? `${onlyA.length} in ${aName} and not in ${bName} (${onlyA.slice(0, 4).join(", ")})` : "",
      onlyB.length ? `${onlyB.length} in ${bName} and not in ${aName} (${onlyB.slice(0, 4).join(", ")})` : "",
    ].filter(Boolean).join("; ") +
      `. Each side is correct on its own; only the pair is wrong, so no test on either side can fail.` +
      // The peer's correction: their three names were not merely unregistered,
      // they were DROPPED as bad_shape, so what a person saw was 120 seconds of
      // nothing and then "your computer is not responding". The cross-layer gap
      // and the timeout were one defect, and pairing them is what makes it
      // findable from the symptom end next time.
      (symptom ? ` What a person sees when this happens: ${symptom}` : ""),
  }
}

/**
 * Is the runtime that will ACTUALLY run this step above the declared floor?
 *
 * `engines` is a declaration. npm reads it at install time and warns; at RUN
 * time nothing reads it at all — so a project can declare `>=22` and have every
 * step execute on 18, silently, for as long as nobody looks.
 *
 * A peer named the mechanism on their machine and it is not exotic: `type -P
 * node` resolves to a wrapper hard-locked to v18.19.1, which also makes nvm
 * ineffective. Anything spawning the string `"node"` gets 18 there, whatever
 * the parent process is running on.
 *
 * Measured here within a minute of reading that: this project's own smoke test
 * spawned bare `"node"`, so every "Node 22 · 5/5" and "Node 24 · 5/5" it had
 * reported was testing the same **v18.19.1** CLI. The parent version changed;
 * the thing under test never did.
 *
 * Two rules follow, and the second is the one that keeps biting:
 *
 *   1. compare the floor against the runtime the STEP will get, not the one the
 *      pipeline is running on
 *   2. spawn `process.execPath`, never the string "node" — otherwise the check
 *      above is measuring one process and the work happens in another
 */
export function runtimeFloorVerdict({ step = "this step", running, floor }) {
  const parse = (v) => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v ?? "").trim())
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
  }
  const min = /(\d+)\.(\d+)\.(\d+)|(\d+)/.exec(String(floor ?? "").replace(/^[^\d]*/, ""))
  const have = parse(running)
  const want = min ? (min[1] ? [Number(min[1]), Number(min[2]), Number(min[3])] : [Number(min[4]), 0, 0]) : null

  if (!have || !want) {
    // Unreadable on either side is not a pass — `sameObserved`'s rule, here.
    return {
      ok: false, known: false,
      reason:
        `could not compare runtimes for "${step}": running=${JSON.stringify(running ?? null)}, ` +
        `floor=${JSON.stringify(floor ?? null)}. An unreadable version is not a satisfied one.`,
    }
  }
  for (let i = 0; i < 3; i++) {
    if (have[i] > want[i]) return { ok: true, known: true, running, floor, reason: `${running} ≥ ${floor}` }
    if (have[i] < want[i]) {
      return {
        ok: false, known: true, running, floor,
        reason:
          `"${step}" will run on ${running}, below the declared floor ${floor}. ` +
          `\`engines\` is read by npm at install time and by nothing at run time, so this is the only place it is enforced. ` +
          `A step that spawns the string "node" gets whatever is first on PATH — use process.execPath.`,
      }
    }
  }
  return { ok: true, known: true, running, floor, reason: `${running} = ${floor}` }
}
