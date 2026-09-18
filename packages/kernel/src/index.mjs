/**
 * @vibeubi/kernel — every decision, and no I/O at all.
 *
 * If a function in this package ever needs the network, the filesystem or a
 * clock it does not receive as an argument, it belongs in an adapter instead.
 * That line is what makes the gate testable, and a gate nobody can test is a
 * gate nobody will hand rollback authority to.
 */
export { verdictFor, earlyVerdict, gateCells } from "./verdict.mjs"
export { deployProof, proofContract, sameObserved } from "./proof.mjs"
export { testRanVerdict } from "./test-ran.mjs"
export { attributedVerdict, needsAttribution, retrySelector, cellKey } from "./attribution.mjs"
export { prereqVerdict } from "./prereq.mjs"
export { reapDecision, runScopedName, newRunId, randomSuffix, cleanupOrder, journeyVerdict, REAP_MAX_AGE_MS, SWEEP_OBJECT_RE } from "./reap.mjs"
export { grade, score, weightOf, unknownSeverities, coverageOf, baselineDiff, atOrAbove, debtAge, SEVERITIES, DEFAULT_FAIL_ON } from "./grade.mjs"
export { rosterVerdict, rosterDrift, toolFingerprint, toolKey, shadowedTools, poisonFindings, patternsAreEscapeOnly, POISON_PATTERNS } from "./roster.mjs"
export { orphanVerdict, requiresHuman, NARROWING_ACTIONS } from "./orphan.mjs"
export { budgetVerdict, vacuousComparison, MIN_BUDGET_MS, MIN_FACTOR, MAX_FACTOR } from "./budget.mjs"
export { baselineAdmission, exemptionScope, checkAssertsOnBehaviour, sourceScanHit, textRuleFitness, declaredFieldsAreRead, READ_DECLARED_FIELDS, NON_CODE_REGIONS } from "./admission.mjs"
export { createContext, applyAll, capabilityCells } from "./plugin.mjs"
export { onboardStage, baselinePlan, prunePlan, STAGES } from "./onboard.mjs"
export { nodeHeapMb, heapOomMessage, killScope, ceilingEffect, hangVerdict, NON_HEAP_SHARE, HEAP_FLOOR_MB, HEAP_CEILING_MB } from "./heap.mjs"
export { manualGapAdmission, manualGapVerdict, manualGapReport, regressionVerdict, isObservation, observationAge, VANTAGE_ANY, observableFrom } from "./manual.mjs"
export { probeOrder, orderVerdict, skillResultAdmission, pageUrl, SKILL_VERDICTS, FREE_INVARIANTS } from "./order.mjs"
export { proofDiscrimination, trimProofHistory } from "./discrimination.mjs"
export { coveredVerdict, crossLayerNames, runtimeFloorVerdict } from "./covered.mjs"
export { SYMPTOMS, findRule, mitigationStillPays } from "./symptoms.mjs"
export { remediationVerdict, implementationsAgree, countIsNotFitness, populationVerdict } from "./claims.mjs"
