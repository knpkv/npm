/** Verified Control Center approval projection for current Clockify revisions. @internal */
import * as Schema from "effect/Schema"

import type { ClockifyApproval } from "../../api/deliveryGraph.js"
import type { EntityId } from "../../domain/identifiers.js"
import type { SourceRevision } from "../../domain/sourceRevision.js"
import type { GovernedActionRecord } from "../persistence/repositories/governedActionRepository.js"
import { ClockifyRecordApprovalPayload } from "../plugins/clockify/ClockifyGovernedActions.js"

/** Select the newest fully verified approval that binds the exact current source revision. */
export const projectClockifyApproval = (
  entityId: EntityId,
  source: SourceRevision,
  records: ReadonlyArray<GovernedActionRecord>
): ClockifyApproval | null => {
  if (source.providerId !== "clockify") return null
  let newest: ClockifyApproval | null = null
  for (const record of records) {
    const { envelope, head } = record
    if (
      envelope.providerId !== "clockify" ||
      envelope.targetEntityId !== entityId ||
      envelope.pluginConnectionId !== source.pluginConnectionId ||
      envelope.proposal.request.actionKind !== "record-approval" ||
      envelope.proposal.request.target.entityType !== "time-entry" ||
      envelope.proposal.request.target.vendorImmutableId !== source.vendorImmutableId ||
      envelope.proposal.request.expectedRevision !== source.revision ||
      head.state !== "succeeded" ||
      head.lineage._tag !== "terminal" ||
      head.lineage.receipt.status !== "succeeded"
    ) continue
    const payload = Schema.decodeUnknownOption(ClockifyRecordApprovalPayload)(
      envelope.proposal.request.payload
    )
    if (
      payload._tag === "None" ||
      payload.value.entryId !== source.vendorImmutableId ||
      payload.value.expectedRevision !== source.revision
    ) continue
    const candidate = {
      actionId: envelope.actionId,
      decision: payload.value.decision,
      rationale: payload.value.rationale,
      decidedAt: head.lineage.receipt.observedAt
    }
    if (
      newest === null ||
      candidate.decidedAt > newest.decidedAt ||
      (candidate.decidedAt === newest.decidedAt && candidate.actionId > newest.actionId)
    ) {
      newest = candidate
    }
  }
  return newest
}
