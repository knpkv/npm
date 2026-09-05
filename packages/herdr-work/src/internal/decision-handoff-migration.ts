import { Schema } from "effect"
import { WorkDecisionHandoff, type WorkDecisionHandoff as WorkDecisionHandoffType } from "../model.js"

export const PreviousWorkDecisionHandoff = Schema.Struct({
  version: Schema.Literal("herdr.work.decision.v1"),
  id: WorkDecisionHandoff.fields.id,
  sessionId: WorkDecisionHandoff.fields.sessionId,
  laneId: WorkDecisionHandoff.fields.laneId,
  goalId: WorkDecisionHandoff.fields.goalId,
  decision: WorkDecisionHandoff.fields.decision,
  summary: WorkDecisionHandoff.fields.summary,
  owner: WorkDecisionHandoff.fields.owner,
  dispatchIds: WorkDecisionHandoff.fields.dispatchIds,
  blockers: WorkDecisionHandoff.fields.blockers,
  evidenceRefs: WorkDecisionHandoff.fields.evidenceRefs,
  occurredAt: WorkDecisionHandoff.fields.occurredAt
})
type PreviousWorkDecisionHandoff = typeof PreviousWorkDecisionHandoff.Type

export const previousDecisionHandoffEquivalent = Schema.toEquivalence(PreviousWorkDecisionHandoff)
export const workDispatchLineageEquivalent = Schema.toEquivalence(WorkDecisionHandoff.fields.dispatchIds)

/** Keeps a dispatch's ordered lineage narrower than the decision's complete dispatch set. */
export const workDispatchLineageContainedBy = (
  lineage: ReadonlyArray<string>,
  dispatchIds: ReadonlyArray<string>
): boolean => lineage.every((dispatchId) => dispatchIds.includes(dispatchId))

export const decodePreviousDecisionHandoff = Schema.decodeUnknownOption(PreviousWorkDecisionHandoff)

/** Upgrades the immediately previous persisted handoff shape without accepting unknown versions. */
export const upgradePreviousDecisionHandoff = (
  previous: PreviousWorkDecisionHandoff,
  expectedRevision: number
): WorkDecisionHandoffType => {
  return Schema.decodeUnknownSync(WorkDecisionHandoff)({
    ...previous,
    contextDelta: previous.summary,
    expectedRevision,
    version: "herdr.work.decision.v2"
  })
}
