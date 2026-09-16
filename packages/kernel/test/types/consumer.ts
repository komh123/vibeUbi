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
