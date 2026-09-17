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
export function attributedVerdict(...args: any[]): any
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

/** "We have a guard" and "the guard ran this month" are different claims. */
export function observationAge(o: {
  lastObservedAt?: number | null
  now?: number
  maxAgeDays?: number
}): { days: number | null; stale: boolean; reason: string }

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
