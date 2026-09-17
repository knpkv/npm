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
    local: record.status === "pending_approval" ? [sanitizeJobRecord(record)] : [],
    nextCursors: [],
    remote: []
  },
  records: [sanitizeJobRecord(record)],
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
  it("redacts spaced credential labels without hiding nearby prose", () => {
    for (const ref of [
      "api key: leaked-canary",
      '{"api key":"leaked-canary"}',
      "Secret Access Key=leaked-canary",
      "access key id: leaked-canary",
      "api%20key%3Aleaked-canary"
    ]) {
      expect(JSON.stringify(approvalRequestFor({ kind: "nix.apply", ref }))).not.toContain("leaked-canary")
    }
    expect(JSON.stringify(approvalRequestFor({ kind: "nix.apply", ref: "api key rotation" }))).toContain(
      "api key rotation"
    )
    expect(
      JSON.stringify(
        approvalRequestFor({
          kind: "nix.apply",
          ref: "password=topsecret, recovery code=leaked-canary"
        })
      )
    ).not.toContain("leaked-canary")
    expect(JSON.stringify(approvalRequestFor({ kind: "nix.apply", ref: "password=secret, branch=main" }))).toContain(
      "branch=main"
    )
  })

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

  it("labels the explicit transition-summary delegate without prompt inference", () => {
    const request = approvalRequestFor({
      kind: "agent.delegate",
      mode: "transition_summary",
      prompt: "internal transition context",
      repository: "/srv/npm"
    })
    expect(request).toMatchObject({ kind: "agent.delegate", title: "Summarize a transition" })
    expect(request.fields[0]).toMatchObject({ key: "mode", value: "transition_summary" })
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

  it("preserves terminal observation evidence in the browser projection", () => {
    const observed = sanitizeJobRecord({
      ...recordFor("succeeded"),
      connectTarget: {
        agentId: "agent-worker",
        host: "ALPHA",
        url: "/connect/?agent=agent-worker&host=ALPHA"
      },
      worker: {
        agentId: "agent-worker",
        host: "ALPHA",
        name: "package-worker",
        paneId: "w1:p1"
      },
      workerTerminalObservedAt: 1_750
    })
    expect(observed.workerTerminalObservedAt).toBe(1_750)
    expect(Schema.decodeUnknownSync(SanitizedJobRecord)(observed)).toEqual(observed)
    expect("workerTerminalObservedAt" in sanitizeJobRecord(recordFor("pending_approval"))).toBe(false)
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

  it("redacts whitespace-bearing URI user-info", () => {
    const ref = "https://deploy-user:deploy password@example.test/revision"
    const request = approvalRequestFor({ kind: "nix.apply", ref })
    const projection = sanitizeJobRecord({
      ...recordFor("pending_approval"),
      payload: { kind: "nix.apply", ref }
    })
    const encoded = JSON.stringify({ request, projection })
    expect(encoded).not.toContain("deploy-user")
    expect(encoded).not.toContain("deploy password")
    expect(encoded).toContain("[redacted credential]")
  })

  it("redacts line breaks in URI user-info", () => {
    for (const lineBreak of ["\r", "\n"]) {
      const ref = `https://deploy-user:deploy${lineBreak}password@example.test/revision`
      const request = approvalRequestFor({ kind: "nix.apply", ref })
      const projection = sanitizeJobRecord({
        ...recordFor("pending_approval"),
        payload: { kind: "nix.apply", ref }
      })
      const encoded = JSON.stringify({ request, projection })
      expect(encoded).not.toContain("deploy-user")
      expect(encoded).not.toContain(`deploy${lineBreak}password`)
      expect(encoded).toContain("[redacted credential]")
    }
  })

  it("normalizes special-scheme authorities without rewriting query data", () => {
    const refs = [
      "https:\\\\user:backslash-secret@example.test\\repo",
      "ftp:\\\\user:ftp-secret@example.test\\repo",
      "ws:\\\\user:ws-secret@example.test\\repo",
      "wss:\\\\user:wss-secret@example.test\\repo"
    ]
    for (const ref of refs) {
      const request = approvalRequestFor({ kind: "nix.apply", ref })
      const projection = sanitizeJobRecord({
        ...recordFor("pending_approval"),
        payload: { kind: "nix.apply", ref }
      })
      const encoded = JSON.stringify({ request, projection })
      expect(encoded).not.toMatch(/(?:backslash|ftp|ws|wss)-secret/u)
      expect(encoded).toContain("[redacted credential]")
    }
    const query = "https://example.test/repo?ref=feature\\candidate"
    expect(approvalRequestFor({ kind: "nix.apply", ref: query }).fields[0]?.value).toBe(query)
  })

  it("redacts complete arbitrary authorization values", () => {
    const refs = ["Authorization: Custom scheme-secret trailing-value", "https://example.test/password%3Dleaked-canary"]
    for (const ref of refs) {
      const request = approvalRequestFor({ kind: "nix.apply", ref })
      const projection = sanitizeJobRecord({
        ...recordFor("pending_approval"),
        payload: { kind: "nix.apply", ref }
      })
      const encoded = JSON.stringify({ request, projection })
      expect(encoded).not.toContain("scheme-secret")
      expect(encoded).not.toContain("trailing-value")
      expect(encoded).not.toContain("leaked-canary")
      expect(request.fields[0]?.value).toContain(
        ref.startsWith("https://") ? "%5Bredacted%20credential%5D" : "[redacted credential]"
      )
    }
  })

  it("redacts arbitrary authorization suffixes through the line terminator", () => {
    const credential = "Authorization: Custom first-secret,second-secret;third-secret"
    const request = approvalRequestFor({ kind: "nix.apply", ref: credential })
    const projection = sanitizeJobRecord({
      ...recordFor("pending_approval"),
      payload: { kind: "nix.apply", ref: credential }
    })
    const encoded = JSON.stringify({ request, projection })
    expect(encoded).not.toContain("first-secret")
    expect(encoded).not.toContain("second-secret")
    expect(encoded).not.toContain("third-secret")
    expect(encoded).toContain("[redacted credential]")
    expect(approvalRequestFor({ kind: "nix.apply", ref: "ref=main,mirror=backup" }).fields[0]?.value).toBe(
      "ref=main,mirror=backup"
    )
  })

  it("redacts cookie headers and folded authorization continuations", () => {
    for (const ref of [
      "Cookie: SID=leaked-cookie-canary; theme=dark",
      "set-cookie: session_id=leaked-set-cookie-canary; Path=/",
      "cookie=plain-cookie-canary",
      "set-cookie=plain-set-cookie-canary",
      "cookie%3Dencoded-cookie-canary",
      "https://example.test/repo?ref=cookie%3Dencoded-query-cookie-canary",
      "Cookie: SID=first-folded-cookie-canary\r\n second-folded-cookie-canary",
      "Set-Cookie: SID=first-folded-set-cookie-canary\n second-folded-set-cookie-canary",
      "Authorization: Basic first-folded-basic-canary\r\n second-folded-basic-canary",
      "Authorization: Digest first-folded-digest-canary\n second-folded-digest-canary",
      "Authorization: Bearer first-folded-canary\r\n second-folded-canary"
    ]) {
      const request = approvalRequestFor({ kind: "nix.apply", ref })
      const projection = sanitizeJobRecord({
        ...recordFor("pending_approval"),
        payload: { kind: "nix.apply", ref }
      })
      const encoded = JSON.stringify({ request, projection })
      expect(encoded).not.toMatch(/(?:cookie|folded)-canary/u)
      expect(encoded).toMatch(/(?:\[redacted credential\]|%5Bredacted%20credential%5D)/u)
    }
    expect(approvalRequestFor({ kind: "nix.apply", ref: "cookiePolicy=strict" }).fields[0]?.value).toBe(
      "cookiePolicy=strict"
    )
    expect(approvalRequestFor({ kind: "nix.apply", ref: "release-cookie=stable" }).fields[0]?.value).toBe(
      "release-cookie=stable"
    )
    const followingField = "Cookie: SID=first-cookie-canary\r\nref=main"
    const followingFieldValue = approvalRequestFor({ kind: "nix.apply", ref: followingField }).fields[0]?.value
    expect(followingFieldValue).not.toContain("first-cookie-canary")
    expect(followingFieldValue).toContain("ref=main")
  })

  it("redacts standalone encoded credential assignments", () => {
    const credential = "password%3Dleaked-canary"
    const encodedPath = "https://example.test/repo/password%253Dleaked-canary"
    const colonPath = "https://example.test/repo/password%3Aleaked-canary"
    const deeplyEncodedColonPath = "https://example.test/repo/password%253Aleaked-canary"
    const visible = "release%2Fcandidate"
    for (const ref of [credential, encodedPath, colonPath, deeplyEncodedColonPath]) {
      const request = approvalRequestFor({ kind: "nix.apply", ref })
      const projection = sanitizeJobRecord({
        ...recordFor("pending_approval"),
        payload: { kind: "nix.apply", ref }
      })
      expect(JSON.stringify({ request, projection })).not.toContain("leaked-canary")
    }
    const request = approvalRequestFor({ kind: "nix.apply", ref: encodedPath })
    expect(request.fields[0]?.value).toContain("%255Bredacted%2520credential%255D")
    const standaloneRequest = approvalRequestFor({ kind: "nix.apply", ref: credential })
    expect(standaloneRequest.fields[0]?.value).toContain("%5Bredacted%20credential%5D")
    expect(approvalRequestFor({ kind: "nix.apply", ref: colonPath }).fields[0]?.value).toContain(
      "%5Bredacted%20credential%5D"
    )
    expect(approvalRequestFor({ kind: "nix.apply", ref: deeplyEncodedColonPath }).fields[0]?.value).toContain(
      "%255Bredacted%2520credential%255D"
    )
    expect(approvalRequestFor({ kind: "nix.apply", ref: visible }).fields[0]?.value).toBe(visible)
    expect(
      approvalRequestFor({ kind: "nix.apply", ref: "https://example.test/repo/release%3Acandidate" }).fields[0]?.value
    ).toBe("https://example.test/repo/release%3Acandidate")
    expect(approvalRequestFor({ kind: "nix.apply", ref: "release%252Fcandidate" }).fields[0]?.value).toBe(
      "release%252Fcandidate"
    )
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

  it("redacts whitespace-bearing unquoted credential values completely", () => {
    for (const ref of [
      "password=first-secret second-secret",
      "password=first-secret\nsecond-secret",
      "password=first-secret\r\nsecond-secret"
    ]) {
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
    expect(approvalRequestFor({ kind: "nix.apply", ref: "ref=release candidate" }).fields[0]?.value).toBe(
      "ref=release candidate"
    )
  })

  it("redacts quoted credential keys in structured coordinates", () => {
    const refs = [
      { ref: '{"password":"json-leaked-canary"}', redacted: "[redacted credential]" },
      { ref: '{"database-password":"prefixed-json-leaked-canary"}', redacted: "[redacted credential]" },
      { ref: '{"Authorization":"quoted-auth-leaked-canary"}', redacted: "[redacted credential]" },
      { ref: '{"pass\\u0077ord":"escaped-json-leaked-canary"}', redacted: "[redacted credential]" },
      { ref: '{"password": plain-json-leaked-canary}', redacted: "[redacted credential]" },
      { ref: '{"Authorization": Bearer plain-auth-leaked-canary}', redacted: "[redacted credential]" },
      { ref: '{"password":123456}', redacted: "[redacted credential]" },
      { ref: '{"credentials":{"value":"structured-leaked-canary"}}', redacted: "[redacted credential]" },
      {
        ref: '{"auths":{"registry.example":{"auth":"docker-auth-leaked-canary"}}}',
        redacted: "[redacted credential]"
      },
      {
        ref: '{"auths":{"one.example":{"auth":"first-docker-auth-leaked-canary"},"two.example":{"auth":"second-docker-auth-leaked-canary"}}}',
        redacted: "[redacted credential]"
      },
      {
        ref: "DefaultEndpointsProtocol=https;AccountName=myacct;AccountKey=azure-leaked-canary;EndpointSuffix=core.windows.net",
        redacted: "[redacted credential]"
      },
      { ref: '{"refreshToken":"camel-token-leaked-canary"}', redacted: "[redacted credential]" },
      { ref: '{"clientSecret":"camel-secret-leaked-canary"}', redacted: "[redacted credential]" },
      { ref: '{"apikey":"compact-api-key-leaked-canary"}', redacted: "[redacted credential]" },
      { ref: '{"accesskey":"compact-access-key-leaked-canary"}', redacted: "[redacted credential]" },
      { ref: '{"privatekey":"compact-private-key-leaked-canary"}', redacted: "[redacted credential]" },
      { ref: '{"password":"quoted-leaked-canary"} trailing-leaked-canary', redacted: "[redacted credential]" },
      {
        ref: "https://example.test/repo?ref=%7B%22password%22%3A%22nested-json-leaked-canary%22%7D",
        redacted: "%5Bredacted%20credential%5D"
      }
    ]
    for (const { redacted, ref } of refs) {
      const request = approvalRequestFor({ kind: "nix.apply", ref })
      const projection = sanitizeJobRecord({
        ...recordFor("pending_approval"),
        payload: { kind: "nix.apply", ref }
      })
      const encoded = JSON.stringify({ request, projection })
      expect(encoded).not.toMatch(
        /(?:json|prefixed-json|nested-json|escaped-json|plain|auth|structured|docker-auth|first-docker-auth|second-docker-auth|azure|camel-token|camel-secret|quoted|trailing)-leaked-canary/u
      )
      expect(encoded).toContain(redacted)
    }
    expect(approvalRequestFor({ kind: "nix.apply", ref: '{"revision":"release"}' }).fields[0]?.value).toBe(
      '{"revision":"release"}'
    )
    expect(approvalRequestFor({ kind: "nix.apply", ref: '{"authority":"registry.example"}' }).fields[0]?.value).toBe(
      '{"authority":"registry.example"}'
    )
    expect(
      approvalRequestFor({ kind: "nix.apply", ref: '{"metadata":{"auth":"visible-auth"}}' }).fields[0]?.value
    ).toBe('{"metadata":{"auth":"visible-auth"}}')
  })

  it("returns long credential-free coordinates without scanning credential patterns", () => {
    const ref = "a".repeat(3 * 1_024)
    const request = approvalRequestFor({ kind: "nix.apply", ref })
    const projection = sanitizeJobRecord({
      ...recordFor("pending_approval"),
      payload: { kind: "nix.apply", ref }
    })
    expect(request.fields[0]?.value).toBe(ref)
    expect(projection.payload.kind).toBe("nix.apply")
    if (projection.payload.kind !== "nix.apply") return
    expect(projection.payload.ref).toBe(ref)
  })

  it("redacts ODBC password assignments and preserves following structured fields", () => {
    const refs = [
      "Driver={PostgreSQL};Uid=deploy;Pwd=odbc-leaked-canary",
      '{"password":"quoted-leaked-canary","revision":"release-2026"}'
    ]
    for (const ref of refs) {
      const request = approvalRequestFor({ kind: "nix.apply", ref })
      const projection = sanitizeJobRecord({
        ...recordFor("pending_approval"),
        payload: { kind: "nix.apply", ref }
      })
      const encoded = JSON.stringify({ request, projection })
      expect(encoded).not.toContain("leaked-canary")
      expect(encoded).toContain("[redacted credential]")
    }
    expect(
      approvalRequestFor({
        kind: "nix.apply",
        ref: '{"password":"quoted-leaked-canary","revision":"release-2026"}'
      }).fields[0]?.value
    ).toBe('{"password":"[redacted credential]","revision":"release-2026"}')
    expect(approvalRequestFor({ kind: "nix.apply", ref: "workingDir=/srv/pwd-cache" }).fields[0]?.value).toBe(
      "workingDir=/srv/pwd-cache"
    )
  })

  it("preserves literal percent characters in filesystem coordinates", () => {
    const ref = "/srv/npm%release"
    const request = approvalRequestFor({ kind: "nix.apply", ref })
    const projection = sanitizeJobRecord({
      ...recordFor("pending_approval"),
      payload: { kind: "nix.apply", ref }
    })
    expect(request.fields[0]?.value).toBe(ref)
    expect(projection.payload.kind === "nix.apply" ? projection.payload.ref : "").toBe(ref)
    const deeplyEncodedCredential = "password%2525253Ddeeply-encoded-canary"
    expect(approvalRequestFor({ kind: "nix.apply", ref: deeplyEncodedCredential }).fields[0]?.value).not.toContain(
      "deeply-encoded-canary"
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
      },
      {
        redacted: "%5Bredacted%20credential%5D",
        ref: "https://user:leaked%2Fcanary@example.test/repo"
      },
      {
        redacted: "%255Bredacted%2520credential%255D",
        ref: "https://example.test/foo%25release-pass%2577ord%253Dleaked-canary"
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
    expect(
      approvalRequestFor({
        kind: "nix.apply",
        ref: "https://host%2Fpath%3Fref%3Drelease"
      }).fields[0]?.value
    ).toBe("https://host%2Fpath%3Fref%3Drelease")
  })

  it("preserves Nix revision identity query fields", () => {
    const ref = "git+https://example.test/repo?rev=abc123&dir=hosts/ser8"
    const request = approvalRequestFor({ kind: "nix.apply", ref })
    const projection = sanitizeJobRecord({
      ...recordFor("pending_approval"),
      payload: { kind: "nix.apply", ref }
    })
    expect(request.fields[0]?.value).toBe(ref)
    expect(projection.payload.kind === "nix.apply" ? projection.payload.ref : "").toBe(ref)
    expect(
      approvalRequestFor({ kind: "nix.apply", ref: "git+https://example.test/repo?token=secret-canary" }).fields[0]
        ?.value
    ).not.toContain("secret-canary")
  })

  it("redacts encoded credential assignments inside safe coordinates", () => {
    for (const ref of [
      "https://mirror.test/?ref=password%3Dleaked-canary",
      "https://mirror.test/?ref=password%ZZ%3Dmalformed-leaked-canary",
      "https://mirror.test/?ref=password%25ZZ%3Ddecode-created-malformed-leaked-canary"
    ]) {
      const request = approvalRequestFor({ kind: "nix.apply", ref })
      const projection = sanitizeJobRecord({
        ...recordFor("pending_approval"),
        payload: { kind: "nix.apply", ref }
      })
      const encoded = JSON.stringify({ request, projection })
      expect(encoded).not.toMatch(/(?:leaked|malformed)-canary/u)
      expect(encoded).toContain("redacted")
    }
  })

  it("redacts queries hidden behind encoded URI authorities", () => {
    const refs = [
      "https://host%2Fpath%3Fref%3Dhttps%253A%252F%252Forigin.test%252Frepo%253Fsig%253Dsecret-canary",
      "https://host%3Fref%3Dsig%253Dsecret-canary%ZZ",
      "https://host%2Fpath%3Fref%3Dfoo%ZZAuthorization: Bearer detached-secret-canary",
      "https://host%2Fpath%3Fref%3Dpassword=%40secret-canary",
      "https://host%2Fpath%3Fref%3Dpassword: leaked-whitespace-canary"
    ]
    for (const ref of refs) {
      const request = approvalRequestFor({ kind: "nix.apply", ref })
      const projection = sanitizeJobRecord({
        ...recordFor("pending_approval"),
        payload: { kind: "nix.apply", ref }
      })
      const encoded = JSON.stringify({ request, projection })
      expect(encoded).not.toContain("secret-canary")
      expect(encoded).toContain("redacted")
    }
  })

  it("redacts whitespace after encoded URI authorities", () => {
    const ref = "https://user%3Aleaked-canary%40origin.test%2Frepo trailing-canary"
    const request = approvalRequestFor({ kind: "nix.apply", ref })
    const projection = sanitizeJobRecord({
      ...recordFor("pending_approval"),
      payload: { kind: "nix.apply", ref }
    })
    const encoded = JSON.stringify({ request, projection })
    expect(encoded).not.toContain("leaked-canary")
    expect(encoded).not.toContain("trailing-canary")
    expect(encoded).toContain("[redacted credential]")

    const safe = "https://origin.test%2Frepo"
    expect(approvalRequestFor({ kind: "nix.apply", ref: safe }).fields[0]?.value).toBe(safe)
  })

  it("redacts encoded query credentials inside URI path segments", () => {
    const refs = [
      "https://example.test/repo%3FX-Amz-Signature%3Dleaked-canary",
      "https://example.test/repo%3Fref%3Dmain"
    ]
    const request = approvalRequestFor({ kind: "nix.apply", ref: refs[0] })
    const projection = sanitizeJobRecord({
      ...recordFor("pending_approval"),
      payload: { kind: "nix.apply", ref: refs[0] }
    })
    const encoded = JSON.stringify({ request, projection })
    expect(encoded).not.toContain("leaked-canary")
    expect(encoded).toContain("%5Bredacted%20credential%5D")
    expect(approvalRequestFor({ kind: "nix.apply", ref: refs[1] }).fields[0]?.value).toBe(refs[1])
  })

  it("redacts credentials in malformed encoded URI path segments", () => {
    const ref = 'https://example.test/repo/foo%ZZ"Authorization"="malformed-auth-leaked-canary"%25ZZ'
    const request = approvalRequestFor({ kind: "nix.apply", ref })
    const projection = sanitizeJobRecord({
      ...recordFor("pending_approval"),
      payload: { kind: "nix.apply", ref }
    })
    const encoded = JSON.stringify({ request, projection })
    expect(encoded).not.toContain("malformed-auth-leaked-canary")
    expect(encoded).toContain("[redacted credential]")

    const invalidUtf8 = "https://example.test/repo/foo%E0%A4x%25"
    const invalidUtf8Request = approvalRequestFor({ kind: "nix.apply", ref: invalidUtf8 })
    expect(invalidUtf8Request.fields[0]?.value).toContain("[redacted credential]")
  })

  it("preserves encoded literal percent characters in safe coordinates", () => {
    const ref = "https://example.test/repo%25release"
    const request = approvalRequestFor({ kind: "nix.apply", ref })
    const projection = sanitizeJobRecord({
      ...recordFor("pending_approval"),
      payload: { kind: "nix.apply", ref }
    })
    expect(request.fields[0]?.value).toBe(ref)
    expect(projection.payload.kind === "nix.apply" ? projection.payload.ref : "").toBe(ref)
  })

  it("decodes credential keys before matching URI path assignments", () => {
    const credentialPath = "https://example.test/repo/pass%77ord%3Dleaked-canary"
    const visiblePath = "https://example.test/repo/pass%77age%3Dvisible-value"
    const request = approvalRequestFor({ kind: "nix.apply", ref: credentialPath })
    const projection = sanitizeJobRecord({
      ...recordFor("pending_approval"),
      payload: { kind: "nix.apply", ref: credentialPath }
    })
    const encoded = JSON.stringify({ request, projection })
    expect(encoded).not.toContain("leaked-canary")
    expect(request.fields[0]?.value).toContain("%5Bredacted%20credential%5D")

    const visible = approvalRequestFor({ kind: "nix.apply", ref: visiblePath })
    expect(visible.fields[0]?.value).toContain("visible-value")
  })

  it("redacts credentials across encoded URI boundaries", () => {
    const refs = [
      {
        ref: "https://example.test%2Frepo%2Fpass%77ord%3Dleaked-canary",
        visible: "%5Bredacted%20credential%5D"
      },
      {
        ref: "https://mirror.test/cache/https%3A%2F%2Fuser%3Aleaked-canary%40origin.test",
        visible: "origin.test"
      },
      {
        ref: "https://mirror.test/?ref=https%3A%2F%2Fuser%3Aleaked-canary%40origin.test%2Frepo",
        visible: "origin.test"
      },
      {
        ref: "https://mirror.test/cache/https%3A%2F%2Forigin.test%2Frepo",
        visible: "origin.test%2Frepo"
      },
      {
        ref: "https://user%3Aleaked-canary%40origin.test/repo",
        visible: "origin.test"
      },
      {
        ref: "https://user%253Aleaked-canary%2540origin.test/repo",
        visible: "origin.test"
      },
      {
        ref: "https://user%25253Aleaked-canary%252540origin.test/repo",
        visible: "origin.test"
      }
    ]
    for (const { ref, visible } of refs) {
      const request = approvalRequestFor({ kind: "nix.apply", ref })
      const projection = sanitizeJobRecord({
        ...recordFor("pending_approval"),
        payload: { kind: "nix.apply", ref }
      })
      const encoded = JSON.stringify({ request, projection })
      expect(encoded).not.toContain("leaked-canary")
      expect(request.fields[0]?.value).toContain(visible)
    }

    const repeatedUserInfo = approvalRequestFor({
      kind: "nix.apply",
      ref: "https://user%3Afirst%40second%3Aleaked-canary%40origin.test/repo"
    })
    const repeatedUserInfoValue = repeatedUserInfo.fields[0]?.value
    expect(repeatedUserInfoValue).toContain("origin.test")
    expect(repeatedUserInfoValue).not.toContain("first")
    expect(repeatedUserInfoValue).not.toContain("second")
    expect(repeatedUserInfoValue).not.toContain("leaked-canary")
  })

  it("redacts credentials from backslash-delimited HTTP authorities", () => {
    const refs = [
      String.raw`https:\user:leaked-canary@example.test\repo`,
      String.raw`https:\\user:leaked-canary@example.test\\repo`
    ]
    for (const ref of refs) {
      const request = approvalRequestFor({ kind: "nix.apply", ref })
      const projection = sanitizeJobRecord({
        ...recordFor("pending_approval"),
        payload: { kind: "nix.apply", ref }
      })
      const encoded = JSON.stringify({ request, projection })
      expect(encoded).not.toContain("leaked-canary")
      expect(encoded).toContain("[redacted credential]")
    }
    const visible = approvalRequestFor({
      kind: "nix.apply",
      ref: String.raw`https:\example.test\repo`
    })
    expect(visible.fields[0]?.value).not.toContain("[redacted credential]")
  })

  it("redacts standalone PEM private-key material while preserving public keys", () => {
    const keyCases = [
      { header: "OPENSSH", footer: "OPENSSH", canary: "b3Bl-leaked-canary" },
      { header: "", footer: "", canary: "pkcs8-leaked-canary" }
    ]
    for (const { canary, footer, header } of keyCases) {
      const privateKey = [
        `-----BEGIN${header === "" ? "" : ` ${header}`} PRIVATE KEY-----`,
        canary,
        `-----END${footer === "" ? "" : ` ${footer}`} PRIVATE KEY-----`
      ].join("\n")
      const request = approvalRequestFor({ kind: "nix.apply", ref: privateKey })
      const projection = sanitizeJobRecord({
        ...recordFor("pending_approval"),
        payload: { kind: "nix.apply", ref: privateKey }
      })
      const encoded = JSON.stringify({ request, projection })
      expect(encoded).not.toContain(canary)
      expect(encoded).toContain("[redacted credential]")
    }

    const pgpPrivateKey = [
      "-----BEGIN PGP PRIVATE KEY BLOCK-----",
      "pgp-leaked-canary",
      "-----END PGP PRIVATE KEY BLOCK-----"
    ].join("\n")
    const pgpRequest = approvalRequestFor({ kind: "nix.apply", ref: pgpPrivateKey })
    const pgpProjection = sanitizeJobRecord({
      ...recordFor("pending_approval"),
      payload: { kind: "nix.apply", ref: pgpPrivateKey }
    })
    const pgpEncoded = JSON.stringify({ request: pgpRequest, projection: pgpProjection })
    expect(pgpEncoded).not.toContain("pgp-leaked-canary")
    expect(pgpEncoded).toContain("[redacted credential]")

    const publicKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIvisible-public-key user@example.test"
    expect(approvalRequestFor({ kind: "nix.apply", ref: publicKey }).fields[0]?.value).toContain("visible-public-key")
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
    const refs = [
      "AWS_SECRET_ACCESS_KEY=first-secret",
      "PRIVATE_KEY=second-secret",
      "ssh_passphrase=third-passphrase-secret",
      "//registry.example/:_auth=fourth-auth-secret"
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
      expect(encoded).not.toContain("third-passphrase-secret")
      expect(encoded).not.toContain("fourth-auth-secret")
      expect(encoded).toContain("[redacted credential]")
    }
    const region = approvalRequestFor({ kind: "nix.apply", ref: "AWS_REGION=us-east-1" })
    expect(region.fields[0]?.value).toBe("AWS_REGION=us-east-1")
  })

  it("redacts passwords in recognizable netrc records", () => {
    for (const ref of [
      "machine example.test login deploy password netrc-leaked-canary",
      "machine example.test\\n login deploy\\n password multiline-netrc-leaked-canary"
    ]) {
      const request = approvalRequestFor({ kind: "nix.apply", ref })
      const projection = sanitizeJobRecord({
        ...recordFor("pending_approval"),
        payload: { kind: "nix.apply", ref }
      })
      const encoded = JSON.stringify({ request, projection })
      expect(encoded).not.toMatch(/(?:netrc|leaked)-canary/u)
      expect(encoded).toContain("[redacted credential]")
    }
    const visible = "machine example.test login deploy account release"
    expect(approvalRequestFor({ kind: "nix.apply", ref: visible }).fields[0]?.value).toBe(visible)
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

  it("redacts unterminated quoted credentials through the end of the value", () => {
    const refs = ['password="first-secret second-secret', "password='first-secret second-secret"]
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
    expect(approvalRequestFor({ kind: "nix.apply", ref: 'ref="release candidate' }).fields[0]?.value).toBe(
      'ref="release candidate'
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
      expect(html).not.toContain("raw terminal result")
      expect(html).not.toContain("raw terminal output")
      expect(html).not.toContain("secret-value")
      expect(html).not.toContain("approval-secret")
    }
  )
})
