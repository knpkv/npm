import { assert, describe, it } from "@effect/vitest"
import { Result, Schema } from "effect"

import {
  ControlCenterLiveEvent,
  CorrelationResponseHeaders,
  CurrentSessionResponse,
  EventCursorFromString,
  MediaResponseHeaders,
  OpaqueMediaId,
  PairingCode,
  PatchPluginConfigurationRequest,
  PluginListResponse,
  PortfolioReleaseCollaborator,
  PortfolioReleaseSummary,
  PortfolioSnapshot,
  SessionListResponse
} from "../../src/api/index.js"
import { PortfolioInvalidatedEventV1 } from "../../src/domain/domainEvent.js"
import { ReleaseId } from "../../src/domain/identifiers.js"
import { deriveReleaseRelay } from "../../src/domain/releaseRelay.js"

const timestamp = "2026-07-14T10:00:00.000Z"
const workspaceId = "01890f6f-6d6a-7cc0-98d2-000000000001"
const sessionId = "01890f6f-6d6a-7cc0-98d2-000000000011"
const personId = "01890f6f-6d6a-7cc0-98d2-000000000021"
const pluginConnectionId = "01890f6f-6d6a-7cc0-98d2-000000000031"
const releaseId = Schema.decodeSync(ReleaseId)("01890f6f-6d6a-7cc0-98d2-000000000041")
const environmentId = "01890f6f-6d6a-7cc0-98d2-000000000042"
const domainEventId = "01890f6f-6d6a-7cc0-98d2-000000000051"
const causationId = "01890f6f-6d6a-7cc0-98d2-000000000052"
const entityId = "01890f6f-6d6a-7cc0-98d2-000000000053"
const jobId = "01890f6f-6d6a-7cc0-98d2-000000000054"

const encodedSession = {
  sessionId,
  workspaceId,
  actor: { _tag: "human", personId },
  permission: "workspace-owner",
  createdAt: timestamp,
  lastSeenAt: timestamp,
  idleExpiresAt: timestamp,
  absoluteExpiresAt: timestamp,
  revokedAt: null
}

const encodedPlugin = {
  pluginConnectionId,
  providerId: "jira",
  displayName: "Delivery Jira",
  isEnabled: true,
  health: null,
  updatedAt: timestamp
}

describe("public API schemas", () => {
  it("accepts only fixed-size lowercase pairing credentials", () => {
    assert.isTrue(Result.isSuccess(Schema.decodeUnknownResult(PairingCode)("ab".repeat(32))))
    assert.isTrue(Result.isFailure(Schema.decodeUnknownResult(PairingCode)("AB".repeat(32))))
    assert.isTrue(Result.isFailure(Schema.decodeUnknownResult(PairingCode)("ab".repeat(31))))
  })

  it("keeps opaque media identifiers non-empty, bounded, and provider-neutral", () => {
    assert.isTrue(Result.isSuccess(Schema.decodeUnknownResult(OpaqueMediaId)(`media_${"ab".repeat(32)}`)))
    assert.isTrue(Result.isFailure(Schema.decodeUnknownResult(OpaqueMediaId)("https://provider.example/avatar")))
    assert.isTrue(Result.isFailure(Schema.decodeUnknownResult(OpaqueMediaId)(`media_${"A".repeat(64)}`)))
  })

  it("validates correlation and hardened media response headers", () => {
    assert.isTrue(
      Result.isSuccess(
        Schema.decodeUnknownResult(CorrelationResponseHeaders)({
          "x-correlation-id": "request:01.abcdef"
        })
      )
    )
    assert.isTrue(
      Result.isFailure(
        Schema.decodeUnknownResult(CorrelationResponseHeaders)({
          "x-correlation-id": "request id with spaces"
        })
      )
    )
    assert.isTrue(
      Result.isSuccess(
        Schema.decodeUnknownResult(MediaResponseHeaders)({
          "x-correlation-id": "request-01",
          "content-type": "image/png",
          "content-length": "2048",
          "cache-control": "private, no-store",
          "x-content-type-options": "nosniff"
        })
      )
    )
    assert.isTrue(
      Result.isFailure(
        Schema.decodeUnknownResult(MediaResponseHeaders)({
          "x-correlation-id": "request-01",
          "content-type": "image/svg+xml",
          "content-length": "2048",
          "cache-control": "private, no-store",
          "x-content-type-options": "nosniff"
        })
      )
    )
    assert.isTrue(
      Result.isFailure(
        Schema.decodeUnknownResult(MediaResponseHeaders)({
          "x-correlation-id": "request-01",
          "content-type": "image/svg+xml",
          "content-length": "-1",
          "cache-control": "public, max-age=3600",
          "x-content-type-options": "nosniff"
        })
      )
    )
  })

  it("bounds session and plugin list responses", () => {
    assert.isTrue(Result.isSuccess(Schema.decodeUnknownResult(SessionListResponse)([encodedSession])))
    assert.isTrue(
      Result.isFailure(
        Schema.decodeUnknownResult(SessionListResponse)(Array.from({ length: 101 }, () => encodedSession))
      )
    )
    assert.isTrue(Result.isSuccess(Schema.decodeUnknownResult(PluginListResponse)([encodedPlugin])))
    assert.isTrue(
      Result.isFailure(Schema.decodeUnknownResult(PluginListResponse)(Array.from({ length: 101 }, () => encodedPlugin)))
    )
  })

  it("bounds named release collaborators and requires explicit release roles", () => {
    const collaborator = {
      personId,
      displayName: "Ada Lovelace",
      avatarFallback: "AL",
      role: "release-owner"
    }
    assert.isTrue(Result.isSuccess(Schema.decodeUnknownResult(PortfolioReleaseCollaborator)(collaborator)))
    assert.isTrue(Result.isFailure(
      Schema.decodeUnknownResult(PortfolioReleaseCollaborator)({
        ...collaborator,
        role: "watcher"
      })
    ))
    const release = {
      releaseId,
      serviceName: "payments-api",
      version: "2.18.0-rc.1",
      lifecycle: "candidate",
      relay: deriveReleaseRelay(releaseId),
      freshness: {
        _tag: "missing",
        pluginHealth: { _tag: "healthy", checkedAt: timestamp },
        provenance: { _tag: "none", pluginConnectionId },
        sourceObservedAt: null,
        staleAfterSeconds: 300,
        synchronizedAt: timestamp
      },
      targetEnvironmentIds: [environmentId],
      collaborators: [collaborator],
      collaboratorCount: 1,
      sourceRevisionCount: 0,
      updatedAt: timestamp
    }
    assert.isTrue(Result.isSuccess(Schema.decodeUnknownResult(PortfolioReleaseSummary)(release)))
    assert.isTrue(Result.isFailure(
      Schema.decodeUnknownResult(PortfolioReleaseSummary)({
        ...release,
        collaborators: [collaborator, collaborator]
      })
    ))
    assert.isTrue(Result.isFailure(
      Schema.decodeUnknownResult(PortfolioReleaseSummary)({
        ...release,
        collaborators: Array.from({ length: 51 }, (_, index) => ({
          ...collaborator,
          personId: `01890f6f-6d6a-7cc0-98d2-${String(index + 100).padStart(12, "0")}`,
          role: index % 2 === 0 ? "release-owner" : "release-approver"
        }))
      })
    ))
  })

  it("returns a bounded CSRF proof with the authenticated current session", () => {
    assert.isTrue(Result.isSuccess(
      Schema.decodeUnknownResult(CurrentSessionResponse)({
        csrfToken: "ab".repeat(32),
        session: encodedSession
      })
    ))
    assert.isTrue(Result.isFailure(
      Schema.decodeUnknownResult(CurrentSessionResponse)({
        csrfToken: "session-secret",
        session: encodedSession
      })
    ))
  })

  it("bounds typed plugin configuration patches and keeps secrets as opaque references", () => {
    const valid = {
      expectedRevision: 4,
      values: [
        { _tag: "boolean", key: "enabled", value: true },
        {
          _tag: "secret-reference",
          key: "token",
          operation: { _tag: "replace", reference: `secret_${"cd".repeat(32)}` }
        }
      ]
    }
    assert.isTrue(Result.isSuccess(Schema.decodeUnknownResult(PatchPluginConfigurationRequest)(valid)))
    assert.isTrue(
      Result.isFailure(
        Schema.decodeUnknownResult(PatchPluginConfigurationRequest)({
          ...valid,
          expectedRevision: -1
        })
      )
    )
    assert.isTrue(
      Result.isFailure(
        Schema.decodeUnknownResult(PatchPluginConfigurationRequest)({
          ...valid,
          values: [
            { _tag: "boolean", key: "enabled", value: true },
            { _tag: "integer", key: "enabled", value: 1 }
          ]
        })
      )
    )
    assert.isTrue(
      Result.isFailure(
        Schema.decodeUnknownResult(PatchPluginConfigurationRequest)({
          ...valid,
          values: [{
            _tag: "secret-reference",
            key: "token",
            operation: { _tag: "replace", reference: "raw-secret-value" }
          }]
        })
      )
    )
    assert.isTrue(
      Result.isSuccess(
        Schema.decodeUnknownResult(PatchPluginConfigurationRequest)({
          expectedRevision: 4,
          values: [{ _tag: "secret-reference", key: "token", operation: { _tag: "keep" } }]
        })
      )
    )
  })

  it("requires non-empty text and explicit HTTP(S) provider URLs", () => {
    const requestWith = (value: unknown) => ({ expectedRevision: 0, values: [value] })
    assert.isTrue(
      Result.isSuccess(
        Schema.decodeUnknownResult(PatchPluginConfigurationRequest)(
          requestWith({ _tag: "url", key: "endpoint", value: "https://jira.example/rest" })
        )
      )
    )
    assert.isTrue(
      Result.isSuccess(
        Schema.decodeUnknownResult(PatchPluginConfigurationRequest)(
          requestWith({ _tag: "url", key: "endpoint", value: "http://127.0.0.1:8080" })
        )
      )
    )
    for (
      const value of [
        "",
        "jira.example",
        "ftp://jira.example",
        "https://user:password@jira.example",
        "https://jira.example/#token"
      ]
    ) {
      assert.isTrue(
        Result.isFailure(
          Schema.decodeUnknownResult(PatchPluginConfigurationRequest)(
            requestWith({ _tag: "url", key: "endpoint", value })
          )
        )
      )
    }
    assert.isTrue(
      Result.isFailure(
        Schema.decodeUnknownResult(PatchPluginConfigurationRequest)(
          requestWith({ _tag: "text", key: "project", value: "" })
        )
      )
    )
  })

  it("accepts a bounded empty portfolio and rejects duplicate plugin identities", () => {
    const emptySnapshot = {
      workspaceId,
      eventCursor: 0,
      generatedAt: timestamp,
      releases: [],
      plugins: []
    }
    assert.isTrue(Result.isSuccess(Schema.decodeUnknownResult(PortfolioSnapshot)(emptySnapshot)))
    assert.isTrue(
      Result.isFailure(
        Schema.decodeUnknownResult(PortfolioSnapshot)({
          ...emptySnapshot,
          plugins: [encodedPlugin, encodedPlugin]
        })
      )
    )
  })

  it("accepts only canonical unsigned-decimal browser cursors", () => {
    for (const cursor of ["0", "1", String(Number.MAX_SAFE_INTEGER)]) {
      assert.isTrue(Result.isSuccess(Schema.decodeUnknownResult(EventCursorFromString)(cursor)))
    }
    for (
      const cursor of [
        "",
        " ",
        "01",
        "+1",
        "-1",
        "1.5",
        "1e3",
        "0x10",
        String(Number.MAX_SAFE_INTEGER + 1),
        "NaN"
      ]
    ) {
      assert.isTrue(Result.isFailure(Schema.decodeUnknownResult(EventCursorFromString)(cursor)))
    }
  })

  it("validates the durable portfolio invalidation envelope", () => {
    const valid = {
      schemaVersion: 1,
      eventId: domainEventId,
      eventCursor: 1,
      workspaceId,
      eventType: "portfolio-invalidated",
      occurredAt: timestamp,
      ingestedAt: timestamp,
      causationId,
      correlationId: "release:projection.42",
      metadata: { releaseId, pluginConnectionId, entityId, jobId },
      payload: { reason: "release-projection" }
    }

    assert.isTrue(Result.isSuccess(Schema.decodeUnknownResult(PortfolioInvalidatedEventV1)(valid)))
    assert.isTrue(
      Result.isSuccess(
        Schema.decodeUnknownResult(PortfolioInvalidatedEventV1)({
          ...valid,
          causationId: null,
          correlationId: null,
          metadata: {},
          payload: { reason: "plugin-health" }
        })
      )
    )
    assert.isTrue(
      Result.isFailure(Schema.decodeUnknownResult(PortfolioInvalidatedEventV1)({ ...valid, eventCursor: 0 }))
    )
    assert.isTrue(
      Result.isFailure(
        Schema.decodeUnknownResult(PortfolioInvalidatedEventV1)({
          ...valid,
          correlationId: "not a safe trace",
          payload: { reason: "arbitrary-json", detail: { unbounded: true } }
        })
      )
    )
  })

  it("decodes the closed live-event union and keeps control frames from advancing the SSE cursor", () => {
    const snapshot = {
      workspaceId,
      eventCursor: 7,
      generatedAt: timestamp,
      releases: [],
      plugins: []
    }
    const invalidation = {
      schemaVersion: 1,
      eventId: domainEventId,
      eventCursor: 7,
      workspaceId,
      eventType: "portfolio-invalidated",
      occurredAt: timestamp,
      ingestedAt: timestamp,
      causationId: null,
      correlationId: "stream:7",
      metadata: { releaseId },
      payload: { reason: "release-projection" }
    }
    const encodedEvents = [
      { id: "7", event: "portfolio.snapshot", data: JSON.stringify(snapshot) },
      { id: "7", event: "portfolio.invalidated", data: JSON.stringify(invalidation) },
      {
        event: "stream.reset-required",
        data: JSON.stringify({ reason: "retention", requestedCursor: 1, headCursor: 7, prunedThroughCursor: 3 })
      },
      { event: "stream.heartbeat", data: JSON.stringify({ eventCursor: 7, sentAt: timestamp }) }
    ]

    for (const event of encodedEvents) {
      assert.isTrue(Result.isSuccess(Schema.decodeUnknownResult(ControlCenterLiveEvent)(event)))
    }
    assert.isTrue(
      Result.isFailure(
        Schema.decodeUnknownResult(ControlCenterLiveEvent)({
          event: "stream.reset-required",
          id: "7",
          data: JSON.stringify({ reason: "retention", requestedCursor: 1, headCursor: 7, prunedThroughCursor: 3 })
        })
      )
    )
    assert.isTrue(
      Result.isFailure(
        Schema.decodeUnknownResult(ControlCenterLiveEvent)({
          event: "stream.reset-required",
          data: JSON.stringify({ reason: "cursor-expired", requestedCursor: 1, headCursor: 7, prunedThroughCursor: 3 })
        })
      )
    )
  })
})
