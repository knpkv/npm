import { describe, expect, it } from "@effect/vitest"
import { renderToStaticMarkup } from "react-dom/server"
import { JobPayload } from "@knpkv/herdr-fleet/model"
import type { JobPayload as JobPayloadType, JobRecord } from "@knpkv/herdr-fleet/model"
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

const approvalPayload: JobPayloadType = {
  channel: "coordinator_chat",
  kind: "agent.delegate",
  mode: "work",
  prompt: "internal terminal prompt with token=secret-value",
  repository: "/srv/npm"
}

const approvalStatuses = ["pending_approval", "succeeded", "rejected", "expired", "failed"] satisfies ReadonlyArray<
  "pending_approval" | "succeeded" | "rejected" | "expired" | "failed"
>
const approvalDashboardStatuses = ["pending_approval", "succeeded", "rejected", "expired"] satisfies ReadonlyArray<
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

  it("redacts suffixes attached to an existing credential marker", () => {
    const refs = [
      "password=[redacted credential]actual-secret",
      "Authorization: Bearer [redacted credential]actual-secret"
    ]
    for (const ref of refs) {
      const request = approvalRequestFor({ kind: "nix.apply", ref })
      const projection = sanitizeJobRecord({
        ...recordFor("pending_approval"),
        payload: { kind: "nix.apply", ref }
      })
      const encoded = JSON.stringify({ request, projection })
      expect(encoded).not.toContain("actual-secret")
      expect(encoded).toContain("[redacted credential]")
    }
    expect(approvalRequestFor({ kind: "nix.apply", ref: "password=[redacted credential]" }).fields[0]?.value).toBe(
      "password=[redacted credential]"
    )
  })

  it("redacts complete authorization credentials and signed URL parameters", () => {
    const refs = [
      "https://deploy-user:deploy-password@example.test/revision?ref=main&X-Amz-Signature=leaked&sig=also-leaked",
      "Authorization: Bearer secret-value",
      "Authorization:Bearer secret-value",
      "authorization=supersecret",
      'Authorization: Digest username="u", response="secret-digest"',
      "https://user:secret-one@secret-two@example.test/repo"
    ]
    const requests = refs.map((ref) => approvalRequestFor({ kind: "nix.apply", ref }))
    expect(requests[0]?.fields[0]?.value).toBe(
      "https://[redacted credential]@example.test/revision?ref=main&X-Amz-Signature=[redacted credential]&sig=[redacted credential]"
    )
    for (const request of requests.slice(1)) {
      expect(request.fields[0]?.value).not.toMatch(/secret|super|username|response/u)
      expect(request.fields[0]?.value).toContain("[redacted credential]")
    }
  })

  it("redacts punctuation-bearing credential values completely", () => {
    const refs = ["password=first-secret,second-secret", "token=first-token;second-token"]
    for (const ref of refs) {
      const request = approvalRequestFor({ kind: "nix.apply", ref })
      const projection = sanitizeJobRecord({
        ...recordFor("pending_approval"),
        payload: { kind: "nix.apply", ref }
      })
      const encoded = JSON.stringify({ request, projection })
      expect(encoded).not.toContain("first-")
      expect(encoded).not.toContain("second-")
      expect(encoded).toContain("[redacted credential]")
    }
    expect(approvalRequestFor({ kind: "nix.apply", ref: "ref=main,mirror=backup" }).fields[0]?.value).toBe(
      "ref=main,mirror=backup"
    )
  })

  it("redacts credentials nested inside safe URL coordinates", () => {
    const refs = [
      {
        redacted: "[redacted credential]",
        ref: "https://mirror.test/?ref=https://origin.test/repo?X-Amz-Signature=leaked-canary&sha=release"
      },
      {
        redacted: "%5Bredacted%20credential%5D",
        ref: "https://mirror.test/?ref=https%3A%2F%2Forigin.test%2Frepo%3FX-Amz-Signature%3Dencoded-canary%26sha%3Drelease"
      },
      {
        redacted: "%255Bredacted%2520credential%255D",
        ref: "https://mirror.test/?ref=https%253A%252F%252Forigin.test%252Frepo%253FX-Amz-Signature%253Ddouble-canary%2526sha%253Drelease"
      },
      {
        redacted: "%5Bredacted%20credential%5D",
        ref: "https://mirror.test/?ref=https%3A%2F%2Fdeploy-user%3Aencoded-password%40example.test%2Frepo"
      },
      {
        redacted: "%255Bredacted%2520credential%255D",
        ref: "https://mirror.test/?ref=https%3A%2F%2Fdeploy-user%253Aencoded-password%2540example.test%2Frepo"
      },
      {
        redacted: "[redacted credential]",
        ref: "//deploy-user:protocol-canary@example.test/repo"
      }
    ]
    for (const { redacted, ref } of refs) {
      const request = approvalRequestFor({ kind: "nix.apply", ref })
      const projection = sanitizeJobRecord({
        ...recordFor("pending_approval"),
        payload: { kind: "nix.apply", ref }
      })
      const encoded = JSON.stringify({ request, projection })
      expect(encoded).not.toMatch(/(?:leaked|encoded|protocol)-canary/u)
      expect(encoded).toContain(redacted)
    }
    expect(approvalRequestFor({ kind: "nix.apply", ref: "//example.test/repo" }).fields[0]?.value).toBe(
      "//example.test/repo"
    )
    expect(
      approvalRequestFor({
        kind: "nix.apply",
        ref: "https://mirror.test/?ref=https%3A%2F%2Forigin.test%2Frepo%3Fsha%3Drelease"
      }).fields[0]?.value
    ).toBe("https://mirror.test/?ref=https%3A%2F%2Forigin.test%2Frepo%3Fsha%3Drelease")
    expect(
      approvalRequestFor({
        kind: "nix.apply",
        ref: "https://mirror.test/?ref=https%253A%252F%252Forigin.test%252Frepo%253Fsha%253Drelease"
      }).fields[0]?.value
    ).toBe("https://mirror.test/?ref=https%253A%252F%252Forigin.test%252Frepo%253Fsha%253Drelease")
  })

  it("redacts encoded credential assignments inside safe coordinates", () => {
    const ref = "https://mirror.test/?ref=password%3Dleaked-canary"
    const request = approvalRequestFor({ kind: "nix.apply", ref })
    const projection = sanitizeJobRecord({
      ...recordFor("pending_approval"),
      payload: { kind: "nix.apply", ref }
    })
    const encoded = JSON.stringify({ request, projection })
    expect(encoded).not.toContain("leaked-canary")
    expect(encoded).toContain("%5Bredacted%20credential%5D")
  })

  it("redacts unsafe query values through raw whitespace", () => {
    const refs = [
      "https://example.test/repo?X-Amz-Signature=first-secret second-secret",
      "https://example.test/repo?sig=first-secret\nsecond-secret"
    ]
    for (const ref of refs) {
      const request = approvalRequestFor({ kind: "nix.apply", ref })
      const projection = sanitizeJobRecord({
        ...recordFor("pending_approval"),
        payload: { kind: "nix.apply", ref }
      })
      const encoded = JSON.stringify({ request, projection })
      expect(encoded).not.toContain("first-secret")
      expect(encoded).not.toContain("second-secret")
      expect(encoded).toContain("[redacted credential]")
    }
    expect(
      approvalRequestFor({ kind: "nix.apply", ref: "https://example.test/repo?ref=release candidate" }).fields[0]?.value
    ).toBe("https://example.test/repo?ref=release candidate")
  })

  it("redacts credential environment assignments while preserving regions", () => {
    const refs = ["AWS_SECRET_ACCESS_KEY=first-secret", "PRIVATE_KEY=second-secret"]
    for (const ref of refs) {
      const request = approvalRequestFor({ kind: "nix.apply", ref })
      const projection = sanitizeJobRecord({
        ...recordFor("pending_approval"),
        payload: { kind: "nix.apply", ref }
      })
      const encoded = JSON.stringify({ request, projection })
      expect(encoded).not.toContain("first-secret")
      expect(encoded).not.toContain("second-secret")
      expect(encoded).toContain("[redacted credential]")
    }
    const region = approvalRequestFor({ kind: "nix.apply", ref: "AWS_REGION=us-east-1" })
    expect(region.fields[0]?.value).toBe("AWS_REGION=us-east-1")
  })

  it("redacts quoted credentials while preserving non-credential labels", () => {
    const refs = ['password="first-secret second-secret"', 'Authorization: Bearer "first-token second-token"']
    for (const ref of refs) {
      const request = approvalRequestFor({ kind: "nix.apply", ref })
      const projection = sanitizeJobRecord({
        ...recordFor("pending_approval"),
        payload: { kind: "nix.apply", ref }
      })
      const encoded = JSON.stringify({ request, projection })
      expect(encoded).not.toContain("first-secret")
      expect(encoded).not.toContain("second-secret")
      expect(encoded).not.toContain("first-token")
      expect(encoded).not.toContain("second-token")
      expect(encoded).toContain("[redacted credential]")
    }
    expect(approvalRequestFor({ kind: "nix.apply", ref: 'ref="release candidate"' }).fields[0]?.value).toBe(
      'ref="release candidate"'
    )
  })

  it("redacts escaped and multiline quoted credentials", () => {
    const refs = [
      'password="first-secret\\"second-secret"',
      'Authorization: Bearer "first-token\\"second-token"',
      "password='first-secret\\'second-secret'",
      "Authorization: Bearer 'first-token\\'second-token'",
      'password="first-line-secret\nsecond-line-secret"',
      'Authorization: Bearer "first-line-token\nsecond-line-token"'
    ]
    for (const ref of refs) {
      const request = approvalRequestFor({ kind: "nix.apply", ref })
      const projection = sanitizeJobRecord({
        ...recordFor("pending_approval"),
        payload: { kind: "nix.apply", ref }
      })
      const encoded = JSON.stringify({ request, projection })
      expect(encoded).not.toContain("first-")
      expect(encoded).not.toContain("second-")
      expect(encoded).toContain("[redacted credential]")
    }
    expect(approvalRequestFor({ kind: "nix.apply", ref: 'ref="release\ncandidate"' }).fields[0]?.value).toBe(
      'ref="release\ncandidate"'
    )
    expect(approvalRequestFor({ kind: "nix.apply", ref: "ref='release candidate'" }).fields[0]?.value).toBe(
      "ref='release candidate'"
    )
  })

  it("redacts signed URLs embedded in coordinate text", () => {
    const refs = [
      "mirror=https://example.test/repo?X-Amz-Signature=leaked-canary",
      "mirror=https://example.test/repo#X-Amz-Signature=fragment-canary",
      "mirror=https://example.test/repo?ref=main"
    ]
    const requests = refs.map((ref) => approvalRequestFor({ kind: "nix.apply", ref }))
    const projections = refs.map((ref) =>
      sanitizeJobRecord({
        ...recordFor("pending_approval"),
        payload: { kind: "nix.apply", ref }
      })
    )
    expect(JSON.stringify({ request: requests[0], projection: projections[0] })).not.toContain("leaked-canary")
    expect(JSON.stringify({ request: requests[1], projection: projections[1] })).not.toContain("fragment-canary")
    expect(JSON.stringify({ request: requests[2], projection: projections[2] })).toContain("ref=main")
    expect(approvalRequestFor({ kind: "nix.apply", ref: "https://example.test/repo#readme" }).fields[0]?.value).toBe(
      "https://example.test/repo#readme"
    )
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

  it("redacts malformed Unicode in encoded safe coordinates", () => {
    const payload = Schema.decodeUnknownSync(JobPayload)({
      kind: "nix.apply",
      ref: `https://example.test/repo?ref=release%2F${"\uD800"}`
    })
    const request = approvalRequestFor(payload)
    const projection = sanitizeJobRecord({ ...recordFor("pending_approval"), payload })
    expect(request.fields[0]?.value).toBe("https://example.test/repo?ref=[redacted credential]")
    expect(() => Schema.decodeUnknownSync(SanitizedJobRecord)(projection)).not.toThrow()
    expect(JSON.stringify({ request, projection })).not.toContain("\\ud800")
  })

  it("is idempotent for already-sanitized coordinates", () => {
    const payload: JobPayloadType = {
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

  it("scopes disclosure region ids to each rendered instance", () => {
    const html = renderToStaticMarkup(
      <>
        <ApprovalRequestDisclosure id="same-job" payload={approvalPayload} />
        <ApprovalRequestDisclosure id="same-job" payload={approvalPayload} />
      </>
    )
    const controls = [...html.matchAll(/aria-controls="([^"]+)"/gu)].map((match) => match[1])
    const regions = [...html.matchAll(/<div class="approval-request-detail" id="([^"]+)"/gu)].map((match) => match[1])
    expect(controls).toHaveLength(2)
    expect(new Set(controls).size).toBe(2)
    expect(regions).toEqual(controls)
  })

  it.each(approvalDashboardStatuses)(
    "keeps the complete redacted request in the approval dashboard for %s",
    (status) => {
      const html = renderDashboard(recordFor(status))
      expect(html).toContain("View full request")
      expect(html).toContain("Repository")
      expect(html).toContain("[redacted internal prompt]")
      expect(html).not.toContain("raw terminal prompt")
      expect(html).not.toContain("secret-value")
      expect(html).not.toContain("approval-secret")
    }
  )
})
