import { ChatHistory } from "@knpkv/herdr-coordinator/model"
import { HostStatus, JobPayload, JobRecord, PendingApprovalCursor } from "@knpkv/herdr-fleet/model"
import { WorkSnapshots } from "@knpkv/herdr-work/model"
import { Schema } from "effect"

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

export const FleetPendingApprovals = Schema.Struct({
  local: Schema.Array(JobRecord),
  remote: Schema.Array(RemotePendingApproval),
  failures: Schema.Array(PendingApprovalFailure)
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
  records: Schema.Array(JobRecord),
  directory: Schema.NullOr(ApprovalDirectory),
  pendingApprovals: FleetPendingApprovals
})

export type ApprovalDirectory = typeof ApprovalDirectory.Type
export type DashboardSnapshot = typeof DashboardSnapshot.Type
export type PendingApproval = typeof PendingApproval.Type
export type PendingApprovalFailure = typeof PendingApprovalFailure.Type
export type PendingApprovalSummary = typeof PendingApprovalSummary.Type
