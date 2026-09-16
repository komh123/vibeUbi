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
  runbook?: string
  probeId?: string
  probe?: () => unknown
}

/** Refuses a gap with no probe: a gap nobody can check is a comment, and a
 *  comment in a gate reads as coverage. */
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
  state: "open" | "closed" | "unmeasured"
  blocks: boolean
  reason: string
}

export function manualGapReport(
  verdicts: readonly { state: string; blocks: boolean; days?: number | null }[],
): { open: number; closed: number; unmeasured: number; blocks: boolean; oldestDays: number | null; verdicts: readonly unknown[] }
