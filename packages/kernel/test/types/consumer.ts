/**
 * A consumer, compiled for real, so the declarations cannot quietly stop
 * describing the implementation.
 *
 * The `@ts-expect-error` lines are the point: each one FAILS THE BUILD if the
 * error stops happening, so they pin the exact mistakes a consumer made against
 * the untyped version.
 */
import { nodeHeapMb, type HeapDecision } from "../../src/index.js"

const d: HeapDecision = nodeHeapMb({ cgroupLimitMb: 8192 })

// Always present, on every branch — the only reason to depend on this function.
const mb: number = d.heapMb
const why: string = d.why

// @ts-expect-error `budgetMb` does not exist on any branch. A consumer invented
// a uniform field set, read this off the fence-below-floor branch, and printed
// "(0 MB)" — a wrong number, which reads like a wrong number rather than like a
// missing field.
const invented = d.numbers.budgetMb

// @ts-expect-error `cgroupLimitMb` is not on the unfenced branch; you have to
// narrow first.
const unnarrowed = d.numbers.cgroupLimitMb

if (d.reason === "unfenced") {
  const avail: number = d.numbers.availableMb
  const reserve: number = d.numbers.reserveMb
  // @ts-expect-error the unfenced branch has no fence to report
  const fence = d.numbers.cgroupLimitMb
  void avail; void reserve; void fence
}

if (d.reason === "fence-below-floor") {
  const fence: number = d.numbers.cgroupLimitMb
  const floor: number = d.numbers.floorMb
  const small: true = d.tooSmall
  void fence; void floor; void small
}

if (d.reason === "fenced") {
  // @ts-expect-error tooSmall is absent on this branch, so a truthiness check
  // that reads it as a boolean is a shape error, not a runtime surprise.
  const small: boolean = d.tooSmall
  void small
}

void mb; void why; void invented; void unnarrowed

/* ── the SECOND shadow ────────────────────────────────────────────────────
 * The consumer deleted its hand-written .d.ts and then kept a local alias with
 * every `numbers` field optional — written for the same reason the .d.ts had
 * them optional, since the branches differ. That re-disabled the narrowing it
 * had just bought, one level up, and tsc went green and said nothing.
 *
 * The first version of this pin asserted the ALIASING is a type error. It is
 * not, and finding that out is the point: excess-property checks only fire on
 * object literals, and every field of the alias is optional, so the union
 * assigns to it cleanly. TypeScript has no complaint to make. THAT is why the
 * second shadow was silent — it is not a mistake the compiler can see.
 *
 * So what is pinned here is what the alias destroys.
 */
type AllOptionalAlias = {
  heapMb: number
  numbers: { cgroupLimitMb?: number; availableMb?: number; floorMb?: number; budgetMb?: number }
}

declare const real: HeapDecision

// Legal, and silent. Left un-suppressed on purpose: if a future TypeScript ever
// does reject this, the unused-directive error would tell us the hazard is gone.
const aliased: AllOptionalAlias = real

// Gone: there is no discriminant left, so nothing can be narrowed.
// @ts-expect-error `reason` does not survive the alias — this is the whole loss.
const stillNarrows = aliased.reason

// And this is the consequence that printed "(0 MB)": through the alias, reading
// a field that exists on NO branch is `number | undefined` rather than an
// error, so `?? 0` looks like prudence instead of a bug.
const invented2: number | undefined = aliased.numbers.budgetMb
const looksPrudent: number = aliased.numbers.budgetMb ?? 0

void aliased; void stillNarrows; void invented2; void looksPrudent

/* ── acceptance ──────────────────────────────────────────────────────────
 * The phase is a closed union, and severity is not optional: both were
 * refused at runtime first, and the types now say so before anything runs. */
import { acceptanceContract, preSwapBehaviourVerdict, foldAttempts, type Acceptance } from "../../src/index.js"

const fulfil: Acceptance["fulfil"] = async () => ({})
const okDecl: Acceptance = { phase: "post-swap", fulfil, items: [{ id: "a", severity: "P0" }] }
const contract = acceptanceContract(okDecl)
if (!contract.ok) { const faults: string[] = contract.faults }

// @ts-expect-error "pre-swap" is not a phase — it was the defect.
const badPhase: Acceptance = { phase: "pre-swap", fulfil, items: [{ id: "a", severity: "P0" }] }

// @ts-expect-error severity is required; a missing one is refused, not defaulted.
const noSeverity: Acceptance = { phase: "post-swap", fulfil, items: [{ id: "a" }] }

const rule = preSwapBehaviourVerdict(okDecl, { productionBase: "https://x" })
const refuses: boolean = rule.refuse
const warns: boolean = rule.warn

const folded = foldAttempts([[{ feature: "a", layer: "acceptance", priority: "P0", status: "fail", reason: "r" }]])
const flakyFeature: string | undefined = folded.flaky[0]?.feature
