import { describe, expect, it } from "vitest"

import {
  renderAgentJobClaimQuery,
  renderAgentJobDispatchCandidatesQuery,
  renderAgentThreadReplayQuery
} from "../src/index.js"

describe("durable agent job queries", () => {
  it("renders the exact bounded dispatch scan for queued or lease-expired active jobs", () => {
    const rendered = renderAgentJobDispatchCandidatesQuery({
      limit: 32,
      observedAt: "2026-07-19T10:00:00.000Z",
      workspaceId: "workspace-secret"
    })

    expect(rendered).toEqual({
      params: [0, "workspace-secret", "queued", "running", "cancel-requested", "2026-07-19T10:00:00.000Z", 32],
      sql:
        "select \"agent_jobs\".\"workspace_id\" as \"workspaceId\", \"agent_jobs\".\"job_id\" as \"jobId\", \"agent_jobs\".\"thread_id\" as \"threadId\", \"agent_jobs\".\"provider_id\" as \"providerId\", \"agent_jobs\".\"model\" as \"model\", \"agent_jobs\".\"access\" as \"access\", \"agent_jobs\".\"prompt\" as \"prompt\", \"agent_jobs\".\"context_fingerprint\" as \"contextFingerprint\", \"agent_jobs\".\"subject_revision\" as \"subjectRevision\", \"agent_jobs\".\"task_context_json\" as \"taskContextJson\", \"agent_jobs\".\"task_context_digest\" as \"taskContextDigest\", \"agent_jobs\".\"state\" as \"state\", \"agent_jobs\".\"created_at\" as \"createdAt\", \"agent_jobs\".\"cancel_requested_at\" as \"cancelRequestedAt\", \"agent_jobs\".\"terminal_at\" as \"terminalAt\", (select coalesce(max(\"agent_job_attempts\".\"attempt_sequence\"), ?) as \"attemptSequence\" from \"agent_job_attempts\" where ((\"agent_job_attempts\".\"workspace_id\" = \"agent_jobs\".\"workspace_id\") and (\"agent_job_attempts\".\"job_id\" = \"agent_jobs\".\"job_id\"))) as \"attemptSequence\" from \"agent_jobs\" where ((\"agent_jobs\".\"workspace_id\" = ?) and ((\"agent_jobs\".\"state\" = ?) or ((\"agent_jobs\".\"state\" in (?, ?)) and (not exists (select \"agent_job_leases\".\"job_id\" as \"jobId\" from \"agent_job_leases\" where ((\"agent_job_leases\".\"workspace_id\" = \"agent_jobs\".\"workspace_id\") and (\"agent_job_leases\".\"job_id\" = \"agent_jobs\".\"job_id\") and (\"agent_job_leases\".\"lease_expires_at\" > ?))))))) order by \"agent_jobs\".\"created_at\" asc, \"agent_jobs\".\"job_id\" asc limit ?"
    })
  })

  it("renders the exact queued-job claim with no prior attempt", () => {
    const rendered = renderAgentJobClaimQuery({
      expectedAttemptSequence: 0,
      expectedState: "queued",
      jobId: "job-secret",
      observedAt: "2026-07-19T10:00:00.000Z",
      workspaceId: "workspace-secret"
    })

    expect(rendered).toEqual({
      params: ["running", "workspace-secret", "job-secret", "queued", "2026-07-19T10:00:00.000Z"],
      sql:
        "update \"agent_jobs\" set \"state\" = ? where ((\"agent_jobs\".\"workspace_id\" = ?) and (\"agent_jobs\".\"job_id\" = ?) and (\"agent_jobs\".\"state\" = ?) and (not exists (select \"agent_job_attempts\".\"job_id\" as \"jobId\" from \"agent_job_attempts\" where ((\"agent_job_attempts\".\"workspace_id\" = \"agent_jobs\".\"workspace_id\") and (\"agent_job_attempts\".\"job_id\" = \"agent_jobs\".\"job_id\")))) and (not exists (select \"agent_job_leases\".\"job_id\" as \"jobId\" from \"agent_job_leases\" where ((\"agent_job_leases\".\"workspace_id\" = \"agent_jobs\".\"workspace_id\") and (\"agent_job_leases\".\"job_id\" = \"agent_jobs\".\"job_id\") and (\"agent_job_leases\".\"lease_expires_at\" > ?))))) returning \"agent_jobs\".\"workspace_id\" as \"workspaceId\", \"agent_jobs\".\"job_id\" as \"jobId\", \"agent_jobs\".\"thread_id\" as \"threadId\", \"agent_jobs\".\"provider_id\" as \"providerId\", \"agent_jobs\".\"model\" as \"model\", \"agent_jobs\".\"access\" as \"access\", \"agent_jobs\".\"prompt\" as \"prompt\", \"agent_jobs\".\"context_fingerprint\" as \"contextFingerprint\", \"agent_jobs\".\"subject_revision\" as \"subjectRevision\", \"agent_jobs\".\"task_context_json\" as \"taskContextJson\", \"agent_jobs\".\"task_context_digest\" as \"taskContextDigest\", \"agent_jobs\".\"state\" as \"state\", \"agent_jobs\".\"created_at\" as \"createdAt\", \"agent_jobs\".\"cancel_requested_at\" as \"cancelRequestedAt\", \"agent_jobs\".\"terminal_at\" as \"terminalAt\""
    })
  })

  it("renders the exact recovery claim while preserving cancellation intent", () => {
    const rendered = renderAgentJobClaimQuery({
      expectedAttemptSequence: 4,
      expectedState: "cancel-requested",
      jobId: "job-secret",
      observedAt: "2026-07-19T10:00:00.000Z",
      workspaceId: "workspace-secret"
    })

    expect(rendered).toEqual({
      params: [
        "cancel-requested",
        "workspace-secret",
        "job-secret",
        "cancel-requested",
        4,
        4,
        "2026-07-19T10:00:00.000Z"
      ],
      sql:
        "update \"agent_jobs\" set \"state\" = ? where ((\"agent_jobs\".\"workspace_id\" = ?) and (\"agent_jobs\".\"job_id\" = ?) and (\"agent_jobs\".\"state\" = ?) and exists (select \"agent_job_attempts\".\"job_id\" as \"jobId\" from \"agent_job_attempts\" where ((\"agent_job_attempts\".\"workspace_id\" = \"agent_jobs\".\"workspace_id\") and (\"agent_job_attempts\".\"job_id\" = \"agent_jobs\".\"job_id\") and (\"agent_job_attempts\".\"attempt_sequence\" = ?))) and (not exists (select \"agent_job_attempts\".\"job_id\" as \"jobId\" from \"agent_job_attempts\" where ((\"agent_job_attempts\".\"workspace_id\" = \"agent_jobs\".\"workspace_id\") and (\"agent_job_attempts\".\"job_id\" = \"agent_jobs\".\"job_id\") and (\"agent_job_attempts\".\"attempt_sequence\" > ?)))) and (not exists (select \"agent_job_leases\".\"job_id\" as \"jobId\" from \"agent_job_leases\" where ((\"agent_job_leases\".\"workspace_id\" = \"agent_jobs\".\"workspace_id\") and (\"agent_job_leases\".\"job_id\" = \"agent_jobs\".\"job_id\") and (\"agent_job_leases\".\"lease_expires_at\" > ?))))) returning \"agent_jobs\".\"workspace_id\" as \"workspaceId\", \"agent_jobs\".\"job_id\" as \"jobId\", \"agent_jobs\".\"thread_id\" as \"threadId\", \"agent_jobs\".\"provider_id\" as \"providerId\", \"agent_jobs\".\"model\" as \"model\", \"agent_jobs\".\"access\" as \"access\", \"agent_jobs\".\"prompt\" as \"prompt\", \"agent_jobs\".\"context_fingerprint\" as \"contextFingerprint\", \"agent_jobs\".\"subject_revision\" as \"subjectRevision\", \"agent_jobs\".\"task_context_json\" as \"taskContextJson\", \"agent_jobs\".\"task_context_digest\" as \"taskContextDigest\", \"agent_jobs\".\"state\" as \"state\", \"agent_jobs\".\"created_at\" as \"createdAt\", \"agent_jobs\".\"cancel_requested_at\" as \"cancelRequestedAt\", \"agent_jobs\".\"terminal_at\" as \"terminalAt\""
    })
  })

  it("renders the exact bounded replay page after the exclusive cursor", () => {
    const rendered = renderAgentThreadReplayQuery({
      afterSequence: 41,
      limit: 100,
      threadId: "thread-secret",
      workspaceId: "workspace-secret"
    })

    expect(rendered).toEqual({
      params: ["workspace-secret", "thread-secret", 41, 100],
      sql:
        "select \"agent_thread_events\".\"workspace_id\" as \"workspaceId\", \"agent_thread_events\".\"thread_id\" as \"threadId\", \"agent_thread_events\".\"event_sequence\" as \"eventSequence\", \"agent_thread_events\".\"job_id\" as \"jobId\", \"agent_thread_events\".\"attempt_sequence\" as \"attemptSequence\", \"agent_thread_events\".\"event_kind\" as \"eventKind\", \"agent_thread_events\".\"payload_json\" as \"payloadJson\", \"agent_thread_events\".\"payload_digest\" as \"payloadDigest\", \"agent_thread_events\".\"payload_byte_length\" as \"payloadByteLength\", \"agent_jobs\".\"task_context_json\" as \"taskContextJson\", \"agent_jobs\".\"task_context_digest\" as \"taskContextDigest\", \"agent_thread_events\".\"occurred_at\" as \"occurredAt\" from \"agent_thread_events\" inner join \"agent_jobs\" on ((\"agent_jobs\".\"workspace_id\" = \"agent_thread_events\".\"workspace_id\") and (\"agent_jobs\".\"job_id\" = \"agent_thread_events\".\"job_id\")) where ((\"agent_thread_events\".\"workspace_id\" = ?) and (\"agent_thread_events\".\"thread_id\" = ?) and (\"agent_thread_events\".\"event_sequence\" > ?)) order by \"agent_thread_events\".\"event_sequence\" asc limit ?"
    })
  })
})
