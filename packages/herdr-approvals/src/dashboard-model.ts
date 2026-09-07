import { ChatHistory } from "@knpkv/herdr-coordinator/model"
import { HostStatus, JobPayload, PendingApprovalCursor } from "@knpkv/herdr-fleet/model"
import { WorkSnapshots } from "@knpkv/herdr-work/model"
import { Schema } from "effect"
import { SanitizedJobRecord } from "./approval-request.js"

export const ApprovalLink = Schema.Struct({
  host: Schema.String,
  online: Schema.Boolean,
  url: Schema.NullOr(Schema.String)
})

export const ApprovalDirectory = Schema.Struct({
  currentUrl: Schema.String,
  links: Schema.Array(ApprovalLink),
  error: Schema.NullOr(Schema.String)
})

export const PendingApproval = Schema.Struct({
  id: Schema.String,
  createdAt: Schema.Number,
  actor: Schema.String,
  approvalExpiresAt: Schema.NullOr(Schema.Number),
  status: Schema.Literal("pending_approval"),
  payload: JobPayload
})

export const PendingApprovalSummary = Schema.Struct({
  host: Schema.String,
  approvals: Schema.Array(PendingApproval),
  nextCursor: Schema.NullOr(PendingApprovalCursor)
})

export const RemotePendingApproval = Schema.Struct({
  host: Schema.String,
  approvalUrl: Schema.String,
  approval: PendingApproval
})

export const PendingApprovalTarget = Schema.Union([
  Schema.TaggedStruct("local", {
    record: SanitizedJobRecord
  }),
  Schema.TaggedStruct("remote", {
    remote: RemotePendingApproval
  })
])

export const PendingApprovalFailure = Schema.Struct({
  host: Schema.String,
  reason: Schema.Literals([
    "offline",
    "unavailable",
    "timeout",
    "request_failed",
    "invalid_response"
  ])
})

export const PendingApprovalContinuation = Schema.Struct({
  host: Schema.String.check(
    Schema.isNonEmpty(),
    Schema.isMaxLength(253),
    Schema.isPattern(/^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/)
  ),
  cursor: PendingApprovalCursor
})

export const FleetPendingApprovals = Schema.Struct({
  local: Schema.Array(SanitizedJobRecord),
  remote: Schema.Array(RemotePendingApproval),
  failures: Schema.Array(PendingApprovalFailure),
  nextCursors: Schema.Array(PendingApprovalContinuation)
})

export const DashboardHistoryPage = Schema.Struct({
  records: Schema.Array(SanitizedJobRecord),
  nextCursor: Schema.NullOr(PendingApprovalCursor)
})

export const DashboardSnapshot = Schema.Struct({
  host: Schema.String,
  observedAt: Schema.Number,
  approvalsEnabled: Schema.Boolean,
  approvalApp: Schema.Struct({
    canonical: Schema.Boolean,
    canonicalUrl: Schema.String,
    chatEnabled: Schema.Boolean,
    pushEnabled: Schema.Boolean
  }),
  chat: Schema.NullOr(ChatHistory),
  work: Schema.NullOr(WorkSnapshots),
  status: HostStatus,
  records: Schema.Array(SanitizedJobRecord),
  historyNextCursor: Schema.NullOr(PendingApprovalCursor),
  directory: Schema.NullOr(ApprovalDirectory),
  pendingApprovals: FleetPendingApprovals
})

export type ApprovalDirectory = typeof ApprovalDirectory.Type
export type FleetPendingApprovals = typeof FleetPendingApprovals.Type
export type DashboardSnapshot = typeof DashboardSnapshot.Type
export type DashboardHistoryPage = typeof DashboardHistoryPage.Type
export type PendingApproval = typeof PendingApproval.Type
export type PendingApprovalFailure = typeof PendingApprovalFailure.Type
export type PendingApprovalContinuation = typeof PendingApprovalContinuation.Type
export type PendingApprovalSummary = typeof PendingApprovalSummary.Type
export type PendingApprovalTarget = typeof PendingApprovalTarget.Type
