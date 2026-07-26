import { describe, expect, it } from "vitest"

import {
  renderAgentJobClaimQuery,
  renderAgentJobDispatchCandidatesQuery,
  renderAgentReviewContextEventsQuery,
  renderAgentThreadReplayQuery,
  renderAgentThreadTailQuery,
  renderLatestAgentReviewQuery
} from "../src/index.js"

const RELEASE_ID_PROJECTION = "\"agent_jobs\".\"release_id\" as \"releaseId\", "
const withoutReleaseIdProjection = (sql: string): string => sql.replace(RELEASE_ID_PROJECTION, "")

describe("durable agent job queries", () => {
  it("renders the exact bounded dispatch scan for queued or lease-expired active jobs", () => {
    const rendered = renderAgentJobDispatchCandidatesQuery({
      limit: 32,
      observedAt: "2026-07-19T10:00:00.000Z",
      taskTags: ["release-chat"],
      workspaceId: "workspace-secret"
    })

    expect(rendered.sql).toContain(RELEASE_ID_PROJECTION.trimEnd())
    expect({ ...rendered, sql: withoutReleaseIdProjection(rendered.sql) }).toEqual({
      params: [
        0,
        "workspace-secret",
        "{\"_tag\":\"release-chat\"%",
        "queued",
        "running",
        "cancel-requested",
        "2026-07-19T10:00:00.000Z",
        32
      ],
      sql:
        "select \"agent_jobs\".\"workspace_id\" as \"workspaceId\", \"agent_jobs\".\"job_id\" as \"jobId\", \"agent_jobs\".\"thread_id\" as \"threadId\", \"agent_jobs\".\"provider_id\" as \"providerId\", \"agent_jobs\".\"model\" as \"model\", \"agent_jobs\".\"access\" as \"access\", \"agent_jobs\".\"prompt\" as \"prompt\", \"agent_jobs\".\"context_fingerprint\" as \"contextFingerprint\", \"agent_jobs\".\"subject_revision\" as \"subjectRevision\", \"agent_jobs\".\"task_context_json\" as \"taskContextJson\", \"agent_jobs\".\"task_context_digest\" as \"taskContextDigest\", \"agent_jobs\".\"state\" as \"state\", \"agent_jobs\".\"created_at\" as \"createdAt\", \"agent_jobs\".\"cancel_requested_at\" as \"cancelRequestedAt\", \"agent_jobs\".\"terminal_at\" as \"terminalAt\", (select coalesce(max(\"agent_job_attempts\".\"attempt_sequence\"), ?) as \"attemptSequence\" from \"agent_job_attempts\" where ((\"agent_job_attempts\".\"workspace_id\" = \"agent_jobs\".\"workspace_id\") and (\"agent_job_attempts\".\"job_id\" = \"agent_jobs\".\"job_id\"))) as \"attemptSequence\" from \"agent_jobs\" where ((\"agent_jobs\".\"workspace_id\" = ?) and (\"agent_jobs\".\"task_context_json\" like ?) and ((\"agent_jobs\".\"state\" = ?) or ((\"agent_jobs\".\"state\" in (?, ?)) and (not exists (select \"agent_job_leases\".\"job_id\" as \"jobId\" from \"agent_job_leases\" where ((\"agent_job_leases\".\"workspace_id\" = \"agent_jobs\".\"workspace_id\") and (\"agent_job_leases\".\"job_id\" = \"agent_jobs\".\"job_id\") and (\"agent_job_leases\".\"lease_expires_at\" > ?))))))) order by \"agent_jobs\".\"created_at\" asc, \"agent_jobs\".\"job_id\" asc limit ?"
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

    expect(rendered.sql).toContain(RELEASE_ID_PROJECTION.trimEnd())
    expect({ ...rendered, sql: withoutReleaseIdProjection(rendered.sql) }).toEqual({
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

    expect(rendered.sql).toContain(RELEASE_ID_PROJECTION.trimEnd())
    expect({ ...rendered, sql: withoutReleaseIdProjection(rendered.sql) }).toEqual({
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

  it("renders the newest bounded thread window", () => {
    const rendered = renderAgentThreadTailQuery({
      limit: 128,
      threadId: "thread-secret",
      workspaceId: "workspace-secret"
    })

    expect(rendered.params).toEqual(["workspace-secret", "thread-secret", 128])
    expect(rendered.sql).toContain(
      "order by \"agent_thread_events\".\"event_sequence\" desc limit ?"
    )
    expect(rendered.sql).not.toContain("\"event_sequence\" >")
  })

  it("renders the newest bounded context events for one stable review thread", () => {
    const rendered = renderAgentReviewContextEventsQuery({
      eventKinds: ["user-message", "review-report", "job-completed", "job-failed", "cancel-requested"],
      limit: 16,
      threadId: "thread-secret",
      workspaceId: "workspace-secret"
    })

    expect(rendered.params).toEqual([
      "workspace-secret",
      "thread-secret",
      "user-message",
      "review-report",
      "job-completed",
      "job-failed",
      "cancel-requested",
      16
    ])
    expect(rendered.sql).toContain(
      "\"agent_thread_events\".\"event_kind\" in (?, ?, ?, ?, ?)"
    )
    expect(rendered.sql).toContain("\"agent_jobs\".\"state\" as \"jobState\"")
    expect(rendered.sql).toContain(
      "order by \"agent_thread_events\".\"event_sequence\" desc limit ?"
    )
  })

  it("renders a bounded newest-job lookup for one exact immutable review subject", () => {
    const taskContextPrefix = "task_%prefix"
    const rendered = renderLatestAgentReviewQuery({
      workspaceId: "workspace-secret",
      subjectRevision: "head-secret",
      taskContextPrefix
    })

    expect(rendered.params).toEqual([
      "workspace-secret",
      "head-secret",
      1,
      taskContextPrefix.length,
      taskContextPrefix,
      1
    ])
    expect(rendered.sql).toContain(
      "where ((\"agent_jobs\".\"workspace_id\" = ?) and (\"agent_jobs\".\"subject_revision\" = ?) and (cast(substr(\"agent_jobs\".\"task_context_json\", ?, ?) as text) = cast(? as text)))"
    )
    expect(rendered.sql).toContain(
      "\"agent_jobs\".\"task_context_digest\" as \"taskContextDigest\""
    )
    expect(rendered.sql).toContain(
      "order by \"agent_jobs\".\"created_at\" desc, \"agent_jobs\".\"job_id\" desc limit ?"
    )
  })

  it("can bind the newest-review lookup to one exact job", () => {
    const rendered = renderLatestAgentReviewQuery({
      workspaceId: "workspace-secret",
      subjectRevision: "head-secret",
      taskContextPrefix: "task-prefix",
      jobId: "job-secret"
    })

    expect(rendered.params).toContain("job-secret")
    expect(rendered.sql).toContain("\"agent_jobs\".\"job_id\" = ?")
  })
})
