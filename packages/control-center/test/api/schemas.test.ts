import { assert, describe, it } from "@effect/vitest"
import { Result, Schema } from "effect"

import {
  CorrelationResponseHeaders,
  MediaResponseHeaders,
  OpaqueMediaId,
  PairingCode,
  PatchPluginConfigurationRequest,
  PluginListResponse,
  PortfolioSnapshot,
  SessionListResponse
} from "../../src/api/index.js"

const timestamp = "2026-07-14T10:00:00.000Z"
const workspaceId = "01890f6f-6d6a-7cc0-98d2-000000000001"
const sessionId = "01890f6f-6d6a-7cc0-98d2-000000000011"
const personId = "01890f6f-6d6a-7cc0-98d2-000000000021"
const pluginConnectionId = "01890f6f-6d6a-7cc0-98d2-000000000031"

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

  it("bounds typed plugin configuration patches and keeps secrets as opaque references", () => {
    const valid = {
      expectedRevision: 4,
      values: [
        { _tag: "boolean", key: "enabled", value: true },
        { _tag: "secret-reference", key: "token", reference: `secret_${"cd".repeat(32)}` }
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
          values: [{ _tag: "secret-reference", key: "token", reference: "raw-secret-value" }]
        })
      )
    )
  })

  it("accepts a bounded empty portfolio and rejects duplicate plugin identities", () => {
    const emptySnapshot = {
      workspaceId,
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
})
