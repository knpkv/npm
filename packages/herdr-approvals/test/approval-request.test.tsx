import { describe, expect, it } from "@effect/vitest"
import { renderToStaticMarkup } from "react-dom/server"
import type { JobPayload, JobRecord } from "@knpkv/herdr-fleet/model"
import { Schema } from "effect"
import { ApprovalRequestDisclosure } from "../src/approval-request-view.js"
import type { DashboardSnapshot } from "../src/dashboard-model.js"
import { DashboardView } from "../src/dashboard-view.js"
import {
  approvalRequestFor,
  SanitizedJobRecord,
  sanitizeJobRecord,
  sanitizeJobPayload
} from "../src/approval-request.js"

const approvalPayload: JobPayload = {
  channel: "coordinator_chat",
  kind: "agent.delegate",
  mode: "work",
  prompt: "internal terminal prompt with token=secret-value",
  repository: "/srv/npm"
}

const approvalStatuses = ["pending_approval", "succeeded", "rejected", "expired"] satisfies ReadonlyArray<
  "pending_approval" | "succeeded" | "rejected" | "expired"
>

const recordFor = (status: JobRecord["status"]): JobRecord => ({
  actor: "owner@example.com",
  approvalExpiresAt: status === "pending_approval" ? 2_000 : null,
  approvalNonce: status === "pending_approval" ? "approval-secret" : null,
  approvedAt: status === "succeeded" ? 1_500 : null,
  approvedBy: status === "succeeded" ? "owner@example.com" : null,
  createdAt: 1_000,
  error: status === "failed" ? "raw terminal output" : null,
  expiredAt: status === "expired" ? 2_000 : null,
  hash: "a".repeat(64),
  id: `job-${status}`,
  payload: approvalPayload,
  rejectedAt: status === "rejected" ? 1_500 : null,
  rejectedBy: status === "rejected" ? "owner@example.com" : null,
  result: status === "succeeded" ? "raw terminal result" : null,
  status,
  updatedAt: 2_000
})

const dashboardFor = (record: JobRecord): DashboardSnapshot => ({
  approvalApp: {
    canonical: true,
    canonicalUrl: "https://ser8.example.test/",
    chatEnabled: true,
    pushEnabled: true
  },
  approvalsEnabled: true,
  chat: null,
  directory: null,
  historyNextCursor: null,
  host: "SER8",
  observedAt: 2_000,
  pendingApprovals: {
    failures: [],
    local: record.status === "pending_approval" ? [record] : [],
    nextCursors: [],
    remote: []
  },
  records: [record],
  status: {
    applyConfigured: false,
    branch: "main",
    dirty: false,
    herdr: { agents: [], available: true, error: null },
    host: "SER8",
    repository: "/repo",
    revision: "abc123"
  },
  work: null
})

const renderDashboard = (record: JobRecord): string =>
  renderToStaticMarkup(
    <DashboardView
      approvalOnly
      busyJobId={null}
      chatBusy={false}
      notificationState="disabled"
      onChatSubmit={undefined}
      onDecision={() => undefined}
      onDisableNotifications={undefined}
      onEnableNotifications={undefined}
      onRefresh={undefined}
      pull={{ distance: 0, ready: false, refreshing: false }}
      snapshot={dashboardFor(record)}
    />
  )

describe("sanitized approval requests", () => {
  it("keeps every typed work field while marking the internal prompt redacted", () => {
    expect(approvalRequestFor(approvalPayload)).toEqual({
      fields: [
        { key: "mode", label: "Mode", redacted: false, value: "work" },
        { key: "repository", label: "Repository", redacted: false, value: "/srv/npm" },
        { key: "channel", label: "Channel", redacted: false, value: "coordinator_chat" },
        { key: "prompt", label: "Prompt", redacted: true, value: "[redacted internal prompt]" }
      ],
      kind: "agent.delegate",
      title: "Delegate agent work"
    })
  })

  it("removes approval secrets and terminal output from the browser projection", () => {
    const sanitized = sanitizeJobRecord(recordFor("pending_approval"))
    expect("hash" in sanitized).toBe(false)
    expect("approvalNonce" in sanitized).toBe(false)
    expect("result" in sanitized).toBe(false)
    expect("error" in sanitized).toBe(false)
    expect(sanitized.payload).toEqual({
      channel: "coordinator_chat",
      kind: "agent.delegate",
      mode: "work",
      prompt: "[redacted internal prompt]",
      repository: "/srv/npm"
    })
    expect("error" in sanitizeJobRecord(recordFor("succeeded"))).toBe(false)
    expect("result" in sanitizeJobRecord(recordFor("succeeded"))).toBe(false)
  })

  it("redacts credentials embedded in safe request coordinates", () => {
    const request = approvalRequestFor({
      kind: "nix.apply",
      ref: "https://deploy-user:deploy-password@example.test/revision?token=secret-token"
    })
    expect(request.fields).toEqual([
      {
        key: "ref",
        label: "Revision",
        redacted: false,
        value: "https://[redacted credential]@example.test/revision?token=[redacted credential]"
      }
    ])
  })

  it("redacts complete authorization credentials and signed URL parameters", () => {
    const request = approvalRequestFor({
      kind: "nix.apply",
      ref: "https://deploy-user:deploy-password@example.test/revision?ref=main&X-Amz-Signature=leaked&sig=also-leaked"
    })
    expect(request.fields[0]?.value).toBe(
      "https://[redacted credential]@example.test/revision?ref=main&X-Amz-Signature=[redacted credential]&sig=[redacted credential]"
    )
    const delegated = approvalRequestFor({
      kind: "agent.delegate",
      mode: "work",
      prompt: "Authorization: Bearer secret-value",
      repository: "/srv/npm"
    })
    expect(delegated.fields.find(({ key }) => key === "prompt")?.value).toBe("[redacted internal prompt]")
  })

  it("keeps maximum-length sanitized payloads within their source schemas", () => {
    const ref = "token=x ".repeat(512)
    const sanitized = sanitizeJobPayload({ kind: "nix.apply", ref })
    expect(sanitized.kind).toBe("nix.apply")
    expect(sanitized.kind === "nix.apply" ? sanitized.ref.length : 0).toBeLessThanOrEqual(4 * 1_024)
    const projection = sanitizeJobRecord({ ...recordFor("pending_approval"), payload: sanitized })
    expect(() => Schema.decodeUnknownSync(SanitizedJobRecord)(projection)).not.toThrow()
  })

  it("bounds astral coordinates by the UTF-16 length used by their schema", () => {
    const sanitized = sanitizeJobPayload({
      kind: "nix.apply",
      ref: `${"😀".repeat(2_040)}?token=secret`
    })
    expect(sanitized.kind).toBe("nix.apply")
    if (sanitized.kind !== "nix.apply") return
    expect(sanitized.ref).not.toContain("secret")
    expect(sanitized.ref.length).toBeLessThanOrEqual(4 * 1_024)
    const projection = sanitizeJobRecord({ ...recordFor("pending_approval"), payload: sanitized })
    expect(() => Schema.decodeUnknownSync(SanitizedJobRecord)(projection)).not.toThrow()
  })

  it("is idempotent for already-sanitized coordinates", () => {
    const payload: JobPayload = {
      kind: "nix.apply",
      ref: "https://example.test/revision?token=secret"
    }
    const once = sanitizeJobPayload(payload)
    const twice = sanitizeJobPayload(once)
    expect(twice).toEqual(once)
  })

  it.each(approvalStatuses)("renders an explicit request disclosure for %s approval state", (status) => {
    const html = renderToStaticMarkup(
      <ApprovalRequestDisclosure id={`request-${status}`} payload={sanitizeJobRecord(recordFor(status)).payload} />
    )
    expect(html).toContain("View full request")
    expect(html).toContain("Mode")
    expect(html).toContain("[redacted internal prompt]")
    expect(html).not.toContain("internal terminal prompt")
    expect(html).not.toContain("approval-secret")
    expect(html).not.toContain("aaaaaaaaaaaaaaaa")
  })

  it.each(approvalStatuses)("keeps the complete redacted request in the approval dashboard for %s", (status) => {
    const html = renderDashboard(recordFor(status))
    expect(html).toContain("View full request")
    expect(html).toContain("Repository")
    expect(html).toContain("[redacted internal prompt]")
    expect(html).not.toContain("raw terminal prompt")
    expect(html).not.toContain("secret-value")
    expect(html).not.toContain("approval-secret")
  })
})
