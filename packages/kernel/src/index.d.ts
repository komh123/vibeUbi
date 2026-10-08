/**
 * Types for the VibeUbi kernel.
 *
 * WHY THESE EXIST, in the words of the consumer who needed them: importing an
 * untyped ESM kernel from TypeScript gives you `any`, so the type check
 * disappears at exactly the boundary you took the dependency for. That consumer
 * hand-wrote a shadow declaration and then correctly called the shadow the
 * bigger risk — a hand-written mirror does not fail when the real shape moves,
 * it just quietly stops describing it, and it looks safe while doing so.
 *
 * So these ship WITH the implementation and are checked against it:
 *   - `npm run typecheck` runs tsc over this file
 *   - `kernel-surface.test.mjs` asserts every runtime export is declared here
 *     and every declared name is exported, so drift is caught without tsc
 *   - `nodeHeapMb`'s return is a DISCRIMINATED UNION on `reason`, because the
 *     `numbers` field set differs per branch and a uniform one was invented by
 *     a consumer, read `budgetMb` off a branch that has no such field, and
 *     printed "(0 MB)" — a wrong number, which reads like a wrong number
 *     rather than like a missing field.
 */

/* ── heap ─────────────────────────────────────────────────────────────── */

export const NON_HEAP_SHARE: number
export const HEAP_FLOOR_MB: number
export const HEAP_CEILING_MB: number

/** Every `numbers` field is a number, so a renderer never has to re-derive. */
export interface HeapFenced {
  heapMb: number
  fenced: true
  reason: "fenced"
  numbers: { cgroupLimitMb: number; nonHeapShare: number; heapMb: number }
  why: string
  tooSmall?: undefined
}

/**
 * The fence is smaller than the pipeline's own floor.
 *
 * `heapMb` is still strictly under `cgroupLimitMb` — that property holds on
 * every branch and is the only reason to depend on this function. What this
 * branch adds is that the value may be too small to run node at all, which is
 * the caller's policy to act on, not the kernel's.
 */
export interface HeapFenceBelowFloor {
  heapMb: number
  fenced: true
  reason: "fence-below-floor"
  numbers: { cgroupLimitMb: number; floorMb: number; derivedMb: number }
  why: string
  tooSmall: true
}

export interface HeapUnfenced {
  heapMb: number
  fenced: false
  reason: "unfenced"
  numbers: {
    availableMb: number
    reserveMb: number
    usableMb: number
    share: number
    floorMb: number
    ceilingMb: number
  }
  why: string
  tooSmall?: undefined
}

export type HeapDecision = HeapFenced | HeapFenceBelowFloor | HeapUnfenced

/**
 * How much heap one node sub-step may have.
 *
 * Everything in MB. `reserveMb` applies to the UNFENCED branch only: a cgroup
 * limit already had the machine's reserve taken out of it by whoever set it,
 * and subtracting twice is the difference between a step that runs and one
 * that cannot start.
 */
export function nodeHeapMb(o: {
  cgroupLimitMb?: number | null
  availableMb?: number
  reserveMb?: number
}): HeapDecision

/** Returns null when the output is not a V8 OOM, so a cgroup kill (137) falls
 *  through to the caller's own path. `forStep`, not `step` — see the source. */
export function heapOomMessage(o: {
  output?: string
  forStep?: string
  heapMb?: number
  availableMb?: number
}): string | null

/**
 * Is this ceiling doing anything, and is it doing harm?
 *
 * `equals` is harmless (the flag did nothing); `lowers` inverts the feature —
 * the pipeline reduced the ceiling while announcing it gave the step N MB.
 * `defaultOldSpaceMb` must be measured by the caller; V8 sizes old-space from
 * machine memory, so a hardcoded constant would be the very thing this finds.
 * Not a field on HeapDecision: that shape is pinned by a consumer's types.
 */
export function ceilingEffect(
  heapMb: number,
  defaultOldSpaceMb: number,
  toleranceMb?: number,
): {
  effect: "raises" | "equals" | "lowers"
  ineffective: boolean
  worse: boolean
  heapMb: number
  defaultOldSpaceMb: number
}

export function killScope(platform?: string): { strategy: "process-group" | "taskkill"; why: string }

/* ── proof ────────────────────────────────────────────────────────────── */

export type DeployProof = { ok: true; artifactId: string } | { ok: false; reason: string }

export function deployProof(o: {
  expected: string
  previous?: string | null
  observed: string
  unreachable?: string
}): DeployProof

/**
 * Compare two INDEPENDENT observations, with a third answer that must exist:
 * same, different, and WE DO NOT KNOW. "Unreadable" needs a representation that
 * is not equal to any real value — `null` has one, `""` and `0` and `false` do
 * not, and two unreadable values are two absences rather than a match.
 */
export function sameObserved(
  a: unknown,
  b: unknown,
  opts?: { what?: string },
): { known: boolean; same: boolean; reason: string }

export function proofContract(claim: {
  external: boolean
  carriesArtifactId: boolean
  source?: string
}): { ok: true } | { ok: false; reason: string }

/* ── grading and the baseline ─────────────────────────────────────────── */

export interface Finding {
  rule: string
  severity: string
  where?: string
  title?: string
  evidence?: string
  why?: string
  fingerprint?: string
  verdict?: string
  /** false when this finding may never be recorded as accepted debt. */
  admissible?: boolean
}

export const SEVERITIES: readonly string[]
export const DEFAULT_FAIL_ON: readonly string[]

export function score(findings: readonly Finding[]): number
/** An unrecognised severity weighs as `high`, never as zero. */
export function weightOf(severity: string): number
export function unknownSeverities(findings: readonly Finding[]): string[]

/** A grade is a claim about coverage, so `grade` is "—" and `score` null when
 *  a requested check could not run. */
export function grade(
  findings: readonly Finding[],
  unmeasured?: readonly string[],
): { grade: string; score: number | null; unmeasured?: string[]; reason?: string }

export function coverageOf(o: { layers?: readonly string[]; skipped?: readonly string[] }): {
  requested: number
  unmeasured: string[]
  ok: boolean
}

export function baselineDiff(
  findings: readonly Finding[],
  baseline: readonly { fingerprint: string }[],
  failOn?: readonly string[],
): { new: Finding[]; known: Finding[]; resolved: { fingerprint: string }[]; blocking: Finding[] }

export function atOrAbove(severity: string, failOn?: readonly string[]): boolean
export function debtAge(
  baseline: readonly { acceptedAt?: number }[],
  now: number,
): { days: number; since: number } | null

/* ── admission ────────────────────────────────────────────────────────── */

export function baselineAdmission(finding: {
  fingerprint?: string
  rule?: string
  severity?: string
  verdict?: string
  reason?: string
  admissible?: boolean
}): { admit: true } | { admit: false; reason: string }

export function exemptionScope(exemption: { target?: string; [k: string]: unknown }): {
  ok: boolean
  reason?: string
}
export function checkAssertsOnBehaviour(check: unknown): { ok: boolean; reason?: string }
export function sourceScanHit(hit: unknown): { ok: boolean; reason?: string }
export function textRuleFitness(o: { hits: readonly unknown[]; name: string }): {
  precision: number
  mayGate: boolean
  reason?: string
}
export function declaredFieldsAreRead(
  declared: readonly Record<string, unknown>[],
  readFields: readonly string[],
): { ok: true } | { ok: false; unread: string[]; reason: string }
export const READ_DECLARED_FIELDS: Readonly<Record<string, string>>
export const NON_CODE_REGIONS: readonly unknown[]

/* ── onboarding ───────────────────────────────────────────────────────── */

export const STAGES: readonly { id: string; what: string }[]

export function onboardStage(o: {
  config: Record<string, unknown> | null
  probe?: Record<string, unknown>
  scan?: { blocking?: readonly unknown[]; coverage?: { ok?: boolean; unmeasured?: readonly string[] } } | null
  discovered?: { total: number; orphans: number } | null
}): {
  stage: string
  index: number
  of: number
  what: string
  blocked: boolean
  asks: { id: string; question: string; why: string }[]
  note: string | null
  done: boolean
}

export function baselinePlan(
  findings: readonly Finding[],
  decisions: Record<string, { verdict?: string; reason?: string }>,
  admission: (f: unknown) => { admit: boolean; reason?: string },
  now?: number,
): {
  admit: { fingerprint: string; rule: string; severity: string; verdict: string; reason: string; acceptedAt: number }[]
  refused: { finding: Finding; why?: string; verdict: string }[]
  undecided: Finding[]
}

export function prunePlan(
  baseline?: readonly { fingerprint: string }[],
  findings?: readonly Finding[],
): { stale: { fingerprint: string }[]; keep: { fingerprint: string }[]; reason: string | null }

/* ── the rest of the judgement surface ────────────────────────────────── */

export function verdictFor(...args: any[]): any
export function earlyVerdict(...args: any[]): any
export function gateCells(...args: any[]): any
export function testRanVerdict(...args: any[]): any
/** Was this red caused by THIS deploy? Three answers, not two.
 *
 *  A re-check runs on the SAME build, so it separates flaky from consistent and
 *  nothing else. Attribution needs BOTH SIDES of the change — pass `onPrevious`
 *  (only obtainable after the rollback) or the verdict reports, honestly, that
 *  the previous build was never observed. Claiming otherwise is how a
 *  pre-existing failure blocks every deploy for ever while the gate announces
 *  it has ruled that out. */
export function attributedVerdict(
  first: readonly Cell[],
  retry: readonly Cell[],
  o?: { onPrevious?: readonly Cell[] },
): {
  ship: boolean
  reason: string
  blocking: Cell[]
  owned: Cell[]
  /** passed on re-check: flaky on this build. NOT an attribution. */
  intermittent: Cell[]
  /** fails on the previous build too: the only real exoneration. */
  preExisting: Cell[]
  /** alias of `intermittent`, kept so existing callers do not silently see []. */
  exonerated: Cell[]
  /** was the other side of the change actually observed? */
  attributed: boolean
}
export function retrySelector(...args: any[]): any
export function cellKey(...args: any[]): any
export function needsAttribution(...args: any[]): any
export function prereqVerdict(...args: any[]): any
export function reapDecision(...args: any[]): any
export function runScopedName(...args: any[]): any
export function journeyVerdict(...args: any[]): any
export function cleanupOrder(...args: any[]): any
export function newRunId(...args: any[]): any
export function randomSuffix(...args: any[]): any
export function rosterVerdict(...args: any[]): any
export function rosterDrift(...args: any[]): any
export function toolFingerprint(...args: any[]): any
export function toolKey(...args: any[]): any
export function shadowedTools(...args: any[]): any
export function poisonFindings(...args: any[]): any
export function patternsAreEscapeOnly(...args: any[]): any
export function orphanVerdict(...args: any[]): any
export function requiresHuman(...args: any[]): any
export function createContext(...args: any[]): any
export function applyAll(...args: any[]): any
export function capabilityCells(...args: any[]): any
export function budgetVerdict(...args: any[]): any
export function vacuousComparison(...args: any[]): any

export const NARROWING_ACTIONS: readonly string[]
export const POISON_PATTERNS: readonly unknown[]
export const SWEEP_OBJECT_RE: RegExp
export const REAP_MAX_AGE_MS: number
export const MIN_BUDGET_MS: number
export const MIN_FACTOR: number
export const MAX_FACTOR: number

/* ── gaps only a human can close ──────────────────────────────────────── */

export interface ManualGap {
  id: string
  why: string
  owner: string
  acceptedAt: number
  /** The run that can actually observe this. A run elsewhere reports
   *  "not-here" rather than a failure it has no standing to claim — a gate
   *  that is red from the first run is a gate the third person deletes. */
  vantage: string
  runbook?: string
  probeId?: string
  probe?: () => unknown
}

/** A closed gap is PROMOTED to one of these, never deleted: the probe is
 *  usually the property's only reader. */
export interface RegressionGuard {
  id: string
  owner: string
  closedAt: number
  vantage?: string
}

/** Refuses a gap with no probe: a gap nobody can check is a comment, and a
 *  comment in a gate reads as coverage. */
/**
 * Only a state carrying a fact ABOUT THE SYSTEM counts as an observation.
 * `not-here` and `unmeasured` carry facts about the RUN. Exported because the
 * obvious caller-side derivation — `state !== "not-here"` — is wrong, and got
 * written by the first person to need it.
 */
export function isObservation(state: string): boolean

/** "We have a guard" and "the guard ran this month" are different claims — and
 *  so are the two ways of never: `never-wired` is a coding task, `never-reached`
 *  means the probe exists and something upstream is starving it. Pass
 *  `lastAttemptedAt` to get the distinction; omit it and the answer stays
 *  honestly undifferentiated rather than guessed. */
export function observationAge(o: {
  lastObservedAt?: number | null
  lastAttemptedAt?: number | null
  now?: number
  maxAgeDays?: number
}): {
  days: number | null
  stale: boolean
  state: "fresh" | "stale" | "never-wired" | "never-reached" | "reached-then-starved"
  fix: "write it" | "look upstream" | "run it" | null
  reason: string
}

export function manualGapAdmission(gap: Partial<ManualGap>): { ok: true } | { ok: false; reason: string }

/** `null` / `{unreachable}` are NOT `{open:false}` — collapsing them is how
 *  "we could not look" becomes "it is fixed". */
export function manualGapVerdict(o: {
  gap: Partial<ManualGap>
  observed: { open: boolean } | { unreachable: string } | null | undefined
  now?: number
}): {
  id?: string
  owner?: string
  days: number | null
  runbook: string | null
  vantage: string | null
  state: "open" | "closed" | "unmeasured" | "not-here"
  /** True only when this verdict came from actually seeing the system. Stamp
   *  a "last observed" timestamp from THIS, never from `state !== "not-here"`. */
  observed: boolean
  blocks: boolean
  /** Present on "closed": move it to a regression guard rather than deleting. */
  promoteTo?: "regression"
  reason: string
}

/**
 * A property that was fixed and must not come back. Severity is inverted from
 * a manual gap: open does not block, REGRESSED does — "it was fixed and broke
 * again" is a different event from "it was never fixed". `unmeasured` blocks
 * too, because this guard exists precisely because the property was once false.
 */
export function regressionVerdict(o: {
  guard: Partial<RegressionGuard>
  observed: { open: boolean } | { unreachable: string } | null | undefined
  at?: string | null
  now?: number
}): {
  id?: string
  owner?: string
  days: number | null
  vantage: string | null
  state: "holding" | "regressed" | "unmeasured" | "not-here"
  observed: boolean
  blocks: boolean
  reason: string
}

export function manualGapReport(
  verdicts: readonly { state: string; blocks: boolean; days?: number | null }[],
): { open: number; closed: number; unmeasured: number; blocks: boolean; oldestDays: number | null; verdicts: readonly unknown[] }

/* ── the step vibeUbi orders and an agent fulfils ─────────────────────── */

export const SKILL_VERDICTS: readonly ["PASS", "PASS_WITH_NOISE", "FAIL", "BLOCKED", "NOT_EXERCISED"]
export const FREE_INVARIANTS: readonly { id: string; why: string }[]

export interface ProbeOrder {
  skill: string
  artifactId: string
  base: string
  at: "probe"
  /** Stated, not inferred: the sequence is not stable across registry edits, so
   *  an item that depends on the previous one breaks on an unrelated change. */
  contract: {
    /** a FRESH SESSION per item — cookies, storage, auth — not just its own
     *  navigation. The natural implementation shares a browser context, and
     *  that sharing is invisible when testing one item at a time. */
    itemsAreIndependent: true
    why: string
    /** what to do with `discovered: false`: answer "is it there" before "is it
     *  good". Loads and passes → the scanner under-reported. 404s → the
     *  declaration is stale. Neither is a fault of this deploy. */
    undiscovered: string
  }
  items: {
    id: string
    /** resolved from base + id, so nobody has to know to strip `page:` */
    url: string
    priority: string
    testId: string | null
    probes: unknown[]
    /** false when it is declared but discovery did not find it — named, not absent */
    discovered: boolean
    invariants: { id: string; why: string }[]
  }[]
}

/** Derived from the registry, ordered by priority: if the expensive step is cut
 *  short it must be cut at the least important end, and what was not reached
 *  has to be NAMED rather than absent. */
export function probeOrder(o: {
  discovered?: readonly { id: string; kind: string }[]
  declared?: readonly Record<string, unknown>[]
  artifactId: string
  base: string
  skill?: string
  only?: readonly string[]
}): ProbeOrder

/** A result file is a REPORT — the class of evidence this product refuses — so
 *  it must name the artifact it was produced against, or yesterday's green file
 *  passes today's ship. */
/** Resolves the URL the skill should open — guessing it wrong means testing a
 *  different page and reporting PASS, which is the worst outcome this step has. */
export function pageUrl(base: string, id: string): string

export function skillResultAdmission(o: {
  order: ProbeOrder
  result: unknown
}): { ok: true } | { ok: false; reason: string }

export function orderVerdict(o: {
  order: ProbeOrder
  result: {
    skill: string
    /** the build this result CLAIMS to be about — usually copied from the order */
    artifactId: string
    /** the build the skill actually READ off the running site. The claim above
     *  is equal by construction when a runner copies it; only this is evidence. */
    observedArtifact?: string
    observed: { id: string; verdict: string; why?: string; evidence?: unknown }[]
  }
  /** default false: measured at ~1 noisy run in 4 on a real app, so strict
   *  would roll back a good deploy about every fourth deploy. */
  noiseIsFailure?: boolean
  /** default false. After a swap, absence of evidence must not undo a good
   *  deploy; before one, refusing is free, so a pre-swap caller sets this. */
  unmeasuredBlocks?: boolean
  /** vibeUbi's OWN look at `base`, taken just before judging — not the skill's
   *  claim about it. Without it, "the deploy took the site down" and "the test
   *  account's password expired" produce the same word and need opposite
   *  handling. `null` is reported as "no look taken", never assumed alive. */
  liveness?: { ok: boolean; status?: number; unreachable?: string; artifact?: string } | null
  /** what the cells call themselves; default "probe". Acceptance passes
   *  "acceptance" so it is judged by THIS function and not by a copy. */
  layer?: string
}): {
  cells: { feature: string; layer: string; priority: string; status: string; reason: string; skillVerdict?: string; volunteered?: boolean }[]
  ordered: number
  covered: number
  /** could not be measured — the deploy stands, and this number is printed */
  unverified: number
  verified: number
}

/* ── does this proof actually tell builds apart? ──────────────────────── */

/** One (artifact, what the proof said) pair. `observed` is null when nothing
 *  could be read — never "", see sameObserved. */
export interface ProofSample {
  artifactId: string
  observed: string | null
  at: number
}

/**
 * `proofContract` asks whether a proof CAN carry an id — a question about
 * shape. This asks whether it DOES tell builds apart, in two directions:
 *
 *   1. different artifacts must produce different values, or the field is
 *      `commit: null` — the same answer for every build
 *   2. the SAME artifact must produce the same value, or the field is
 *      `loadedAt` — it changes on every deploy, passes (1), and gives a
 *      rollback a NEW timestamp for an OLD build
 */
export function proofDiscrimination(
  samples?: readonly ProofSample[],
  opts?: { minArtifacts?: number },
): { known: boolean; ok: boolean; verdict: "unmeasured" | "no-power" | "identifies-something-else" | "discriminating"; reason: string }

/** Bounded history that keeps the FIRST and last sighting of every artifact —
 *  the older sample is the only one direction 2 can use. */
export function trimProofHistory(samples?: readonly ProofSample[], max?: number): ProofSample[]

/* ── did the step look at anything, and at everything? ────────────────── */

/**
 * `testRanVerdict` for the checkers that print no TAP. A type checker over an
 * empty file set exits 0 exactly like one that found no problems — measured on
 * a real service that went four months unchecked because a root config
 * excluded it, and whose first real check found six defects.
 */
export function coveredVerdict(o: {
  step: string
  read?: readonly string[]
  expected?: readonly string[]
  how?: string
}): { ok: true; checked: number } | { ok: false; reason: string; unchecked?: string[] }

/**
 * Names on one side of a boundary must be registered on the other. Neither
 * side is authoritative: each is correct alone and only the pair is wrong,
 * which is why no test on either side can fail.
 */
export function crossLayerNames(o: {
  a?: readonly string[]
  b?: readonly string[]
  aName?: string
  bName?: string
  /** What a person sees when this gap happens — e.g. "a 120s timeout saying
   *  your computer is not responding". The gap and the symptom are one defect,
   *  and pairing them is what makes it findable from the symptom end. */
  symptom?: string
}): { ok: boolean; known: boolean; onlyA: string[]; onlyB: string[]; reason: string }

/**
 * `engines` is read by npm at install time and by nothing at run time. Compare
 * the floor against the runtime the STEP will get — not the one the pipeline is
 * running on — and spawn `process.execPath`, never the string "node".
 */
export function runtimeFloorVerdict(o: {
  step?: string
  running?: string | null
  floor?: string | null
}): { ok: boolean; known: boolean; running?: string | null; floor?: string | null; reason: string }

/* ── symptoms.mjs ─────────────────────────────────────────────────────────── */

/** One defect, keyed on what a person SEES rather than on its name. */
export interface Symptom {
  /** the kernel export that catches it */
  rule: string
  /** things people actually said while hitting this — the searchable side */
  seen: string[]
  why: string
  use: string
}

/** The discovery map. You cannot import what you cannot find, and a flat index
 *  of 85 exports is not a discovery mechanism. */
export const SYMPTOMS: readonly Symptom[]

/** Search the map by what you can observe. Returns [] rather than a bad guess. */
export function findRule(
  query: string,
  symptoms?: readonly Symptom[],
): (Symptom & { score: number; matched: string[] })[]

/** Does the mitigation still cost less than the path it avoids? A guard that
 *  asks whether a cache EXISTS never re-checks the premise it was chosen on. */
export function mitigationStillPays(o: {
  mitigated: number
  plain: number
  ceiling?: number
  what?: string
}): {
  ok: boolean
  known: boolean
  mitigated?: number
  plain?: number
  ceiling?: number
  reason: string
}

/* ── claims.mjs — four ways a true statement answers the wrong question ───── */

/** A remediation is a claim that doing this will change your situation. It can
 *  be false: "update the app" for a cause updating cannot clear. */
export function remediationVerdict(o: {
  cause: string
  remediation: string
  resolves?: readonly string[]
  seen?: string
}): { ok: boolean; known: boolean; cause?: string; remediation?: string; reason: string }

/** Run every copy of one rule over the same inputs. Copies that were never meant
 *  to exist are not declared a pair, so nothing compares them — and each is
 *  individually correct and individually tested. */
export function implementationsAgree(o: {
  rule?: string
  implementations: Record<string, (x: any) => any>
  cases?: readonly any[]
}): {
  ok: boolean
  known: boolean
  names: string[]
  disagreements?: string[]
  agreedOn?: number
  reason: string
}

/** "How many came back" and "are any of them what I asked for" are different
 *  measurements that happen to arrive together. */
export function countIsNotFitness(o: {
  counted: number
  checked?: number
  fit?: number
  claim?: string
}): { ok: boolean; known: boolean; counted?: number; checked?: number; fit?: number; reason: string }

/** The arithmetic is fine and the denominator is a different group, which no
 *  recomputation will reveal. */
export function populationVerdict(o: {
  claimAbout: string
  measured: string
  n?: number
  statistic?: string
}): { ok: boolean; known: boolean; claimAbout?: string; measured?: string; n?: number; reason: string }

/* ── heap.mjs ─────────────────────────────────────────────────────────────── */

/** Why did the step stop making progress — and is that knowable at all?
 *
 *  `unknown` is a first-class state and its message carries NO theory: a
 *  confident wrong diagnosis is strictly worse than silence, because silence
 *  sends nobody anywhere. `loadAvg1` is accepted and is never a discriminator —
 *  a thrashing process sits in D state and a hung one sits at the same number. */
export function hangVerdict(o?: {
  quietForMs?: number
  loadAvg1?: number
  rssGb?: number
  swapUsedGb?: number
  swapUsedGbAtStart?: number
  ceilingGb?: number
  step?: string
}): {
  state: "thrashing" | "quiet" | "unknown"
  known: boolean
  swapGrowth: number | null
  headroom: number | null
  loadAvg1?: number
  message: string
}

/* ── manual.mjs — the vantage sentinel ────────────────────────────────────── */

/** `vantage: "any"` — the declarant asserts this probe depends on nothing
 *  run-specific, so every run can observe it.
 *
 *  A sentinel, deliberately, rather than a looser comparison: relaxing the match
 *  would make every typo a wildcard. Not an escape hatch either — a probe that
 *  really needs a live sandbox and claims "any" returns `unreachable` where the
 *  sandbox is absent, which is unmeasured and BLOCKS. Claiming it falsely makes
 *  your gate redder, not greener. */
export const VANTAGE_ANY: "any"

/** Can a run at `at` observe a gap declared for `vantage`? */
export function observableFrom(vantage: string | null | undefined, at: string | null | undefined): boolean

/* ── acceptance: functional behaviour, judged after the swap ──────────── */

/** The only two places acceptance may run. */
export const ACCEPTANCE_PHASES: readonly ["post-swap", "pre-swap-health"]
export const ACCEPTANCE_SEVERITIES: readonly ["P0", "P1", "P2"]
export const ACCEPTANCE_JUDGES: readonly ["health", "behaviour"]
/** pre-swap-health is "one shortest request", not a test run: 120 s at most. */
export const HEALTH_BUDGET_MAX_MS: number
export const ACCEPTANCE_MAX_ATTEMPTS: number

export type AcceptancePhase = "post-swap" | "pre-swap-health"
export type AcceptanceSeverity = "P0" | "P1" | "P2"

export interface AcceptanceItem {
  id: string
  /** REQUIRED. P0 rolls back after the swap (and refuses before it); P1/P2 are
   *  recorded and warned. Refused when missing — never defaulted. */
  severity: AcceptanceSeverity
  /** required in `pre-swap-health`, where it is the safety argument */
  judges?: "health" | "behaviour"
  /** 1..5, default 1. Only a P0 item may retry; pass-on-retry is `flaky`. */
  attempts?: number
  /** the project's own fields (a path, a role…) pass through to the order */
  [extra: string]: unknown
}

export interface Acceptance {
  phase: AcceptancePhase
  /** Produces the result for an order. Required: nothing else ever would. */
  fulfil: (order: AcceptanceOrder, ctx?: { signal?: AbortSignal; attempt?: number }) => Promise<unknown> | unknown
  items: AcceptanceItem[]
  skill?: string
  /** pre-swap-health only: must be declared, and `true` unless `staging` is */
  healthOnly?: boolean
  /** pre-swap-health: required, 1..HEALTH_BUDGET_MAX_MS. post-swap: optional. */
  timeBudgetMs?: number
  /** pre-swap-health only. The one exception to "no behaviour before the swap". */
  staging?: { base: string }
  noiseIsFailure?: boolean
}

export function acceptanceContract(
  decl: unknown,
  o?: { productionBase?: string | null },
): { ok: true } | { ok: false; reason: string; faults: string[] }

export function preSwapBehaviourVerdict(
  decl: Partial<Acceptance> | null | undefined,
  o?: { productionBase?: string | null },
): {
  /** ship must refuse before anything runs */
  refuse: boolean
  /** allowed, but the operator must be told (the staging exception) */
  warn: boolean
  reason: string
  /** which items / flags made it functional */
  offending: string[]
}

export interface AcceptanceOrder extends Omit<ProbeOrder, "at" | "items"> {
  at: "acceptance"
  /** the declared items, with `priority` = severity so the probe's judge reads them */
  items: (AcceptanceItem & { priority: AcceptanceSeverity })[]
  phase: AcceptancePhase
  healthOnly?: boolean
  timeBudgetMs?: number
  limits?: string
}

export function acceptanceOrder(o: { acceptance: Acceptance; artifactId: string; base: string }): AcceptanceOrder

/** The probe's judge, with cells named `layer: "acceptance"`. Before the swap
 *  (`pre-swap-health`) an unmeasured item errors and so refuses. */
export function acceptanceVerdict(o: {
  order: AcceptanceOrder
  result: unknown
  liveness?: { ok: boolean; status?: number; unreachable?: string; artifact?: string } | null
  phase?: AcceptancePhase
  noiseIsFailure?: boolean
}): ReturnType<typeof orderVerdict>

export interface AcceptanceCell {
  feature: string
  layer: string
  priority: string
  status: string
  reason: string
  flaky?: boolean
  attempts?: number
  [extra: string]: unknown
}

/** ids worth another attempt: FAILED, P0, attempts left, and nothing structural failing */
export function retryItems(o: { order: AcceptanceOrder; cells: readonly AcceptanceCell[]; attemptsDone: number }): string[]

export function foldAttempts(rounds: readonly (readonly AcceptanceCell[])[]): {
  cells: AcceptanceCell[]
  flaky: { feature: string; attempts: number; failures: string[] }[]
}

/** Every step's result from a diagnostic run (no stop at the first red). Never deploy evidence:
 *  the report has `kind: "diagnostic"`, `evidence: false`, and `clean` instead of `ok`. */
export function diagnoseSummary(results: readonly { name: string; ok: boolean; code?: number; timedOut?: boolean; oom?: string | null; reason?: string | null; ms?: number; passed?: number }[]): {
  kind: "diagnostic"; evidence: false; total: number; passed: number
  failed: { name: string; why: string }[]; clean: boolean; headline: string
}
/** The one question a gate asks of a report: may it count as evidence? Refuses diagnostic, narrowed,
 *  red, wrong-phase and wrong-tree reports. */
export function countsAsEvidence(report: unknown, want?: { phase?: string; sourceTree?: string }): { ok: true } | { ok: false; reason: string }
export const DIAGNOSTIC_KIND: "diagnostic"
export const DIAGNOSTICS_DIR: string

/** Statuses a planned item can end in. `not-run` is never pass and never fail. */
export const PLAN_STATUSES: readonly ["pass", "fail", "blocked", "not-run"]
export type PlanStatus = "pass" | "fail" | "blocked" | "not-run"
export interface PlanItem { id: string; after?: readonly string[]; severity?: string }
/** Validate a test plan and order it: stable topological order (declaration order wherever
 *  `after` allows), or every violation (duplicate, unknown `after`, self-dependency, cycle) in one pass. */
export function testPlan(items: readonly PlanItem[]): { ok: true; order: string[] } | { ok: false; violations: string[] }
/** True only when every `after` prerequisite has status 'pass'. */
export function readyToRun(item: { after?: readonly string[] }, statuses?: Record<string, string | { status: string }>): boolean
/** The round's outcome: per-item status (blocked items carry the transitive ROOT failures in `blockedBy`),
 *  `fixFirst` (failures by how much they block), `deferred` (blocked ids), `clean` (every item passed). */
export function planOutcome(
  items: readonly PlanItem[],
  results?: Record<string, "pass" | "fail" | "not-run" | { status: string; reason?: string }>,
): {
  items: { id: string; severity?: string; status: PlanStatus; blockedBy?: string[]; reason?: string }[]
  fixFirst: { id: string; blocks: number }[]
  deferred: string[]
  clean: boolean
  headline: string
}
