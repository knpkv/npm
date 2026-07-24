import { assert, describe, it } from "@effect/vitest"
import * as Encoding from "effect/Encoding"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"

import {
  AuthorizedPluginActionV1,
  DiffContentRangeRequestV1,
  DiffContentRangeRequestV2,
  DiffContentRangeV1,
  NegotiatedPluginDescriptorV1,
  NormalizedPluginEventV1,
  PluginActionCancellationResultV1,
  PluginActionDispatchResultV1,
  PluginDescriptorV1,
  PluginProviderReceiptV1,
  PluginSyncPageV1,
  ProposePluginActionRequestV1
} from "../../src/domain/plugins/index.js"

const observedAt = "2026-07-13T10:00:00.000Z"

const descriptor = {
  contractId: "dev.knpkv.control-center.plugin",
  contractVersion: { major: 1, minor: 2, patch: 0 },
  pluginId: "dev.knpkv.fake-jira",
  adapterVersion: { major: 0, minor: 1, patch: 0 },
  displayName: "Fake Jira",
  configurationFields: [
    {
      _tag: "secret-reference",
      key: "credential",
      label: "Credential",
      description: "Opaque credential reference",
      required: true,
      secretKind: "token"
    }
  ],
  capabilities: [
    {
      capabilityId: "sync.incremental",
      supportedVersions: [1],
      requirement: "required"
    }
  ]
}

describe("plugin domain contract", () => {
  it("decodes structured descriptors without configuration secret values", () => {
    const decoded = Schema.decodeUnknownSync(PluginDescriptorV1)(descriptor)
    assert.strictEqual(decoded.pluginId, "dev.knpkv.fake-jira")
    assert.deepStrictEqual(Object.keys(decoded.configurationFields[0] ?? {}).sort(), [
      "_tag",
      "description",
      "key",
      "label",
      "required",
      "secretKind"
    ])
  })

  it("keeps adapter events vendor-neutral and unable to choose host scope", () => {
    const event = Schema.decodeUnknownSync(NormalizedPluginEventV1)({
      _tag: "UpsertEntity",
      eventId: "event-1",
      observedAt,
      entityType: "issue",
      vendorImmutableId: "PAY-42",
      revision: "7",
      sourceUrl: "https://jira.example/browse/PAY-42",
      title: "Ship payment retry",
      attributes: { status: "In progress" }
    })

    assert.strictEqual("workspaceId" in event, false)
    assert.strictEqual("pluginConnectionId" in event, false)
  })

  it("bounds whole sync pages while allowing an empty checkpoint advance", () => {
    const page = Schema.decodeUnknownSync(PluginSyncPageV1)({
      events: [],
      checkpointAfterPage: "checkpoint-1",
      hasMore: false
    })
    assert.strictEqual(page.events.length, 0)

    const oversized = Schema.decodeUnknownResult(PluginSyncPageV1)({
      events: Array.from({ length: 501 }, (_, index) => ({
        _tag: "TombstoneEntity",
        eventId: `event-${index}`,
        observedAt,
        entityType: "issue",
        vendorImmutableId: `PAY-${index}`,
        revision: "1",
        reason: "deleted"
      })),
      checkpointAfterPage: "checkpoint-2",
      hasMore: false
    })
    assert.isTrue(Result.isFailure(oversized))
  })

  it("rejects an aggregate sync page larger than one encoded MiB", () => {
    const payload = "x".repeat(210_000)
    const page = Schema.decodeUnknownResult(PluginSyncPageV1)({
      events: Array.from({ length: 5 }, (_, index) => ({
        _tag: "UpsertEntity",
        eventId: `event-large-${index}`,
        observedAt,
        entityType: "issue",
        vendorImmutableId: `PAY-LARGE-${index}`,
        revision: "1",
        sourceUrl: null,
        title: "Individually valid payload",
        attributes: { payload }
      })),
      checkpointAfterPage: "checkpoint-large",
      hasMore: false
    })

    assert.isTrue(Result.isFailure(page))
  })

  it("bounds descriptor collections and total encoded size", () => {
    const tooManyVersions = Schema.decodeUnknownResult(PluginDescriptorV1)({
      ...descriptor,
      capabilities: [
        {
          capabilityId: "sync.incremental",
          supportedVersions: Array.from({ length: 17 }, (_, index) => index + 1),
          requirement: "required"
        }
      ]
    })
    const oversizedDescriptor = Schema.decodeUnknownResult(PluginDescriptorV1)({
      ...descriptor,
      configurationFields: Array.from({ length: 100 }, (_, index) => ({
        _tag: "text",
        key: `field-${index}-${"k".repeat(80)}`,
        label: `Field ${index} ${"l".repeat(180)}`,
        description: "d".repeat(500),
        required: false
      }))
    })

    assert.isTrue(Result.isFailure(tooManyVersions))
    assert.isTrue(Result.isFailure(oversizedDescriptor))
  })

  it("rejects oversized normalized attributes and governed-action payloads", () => {
    const oversizedValue = "x".repeat(262_144)
    const event = Schema.decodeUnknownResult(NormalizedPluginEventV1)({
      _tag: "UpsertEntity",
      eventId: "event-oversized",
      observedAt,
      entityType: "issue",
      vendorImmutableId: "PAY-99",
      revision: "1",
      sourceUrl: null,
      title: "Oversized attributes",
      attributes: { value: oversizedValue }
    })
    const action = Schema.decodeUnknownResult(ProposePluginActionRequestV1)({
      actionKind: "transition",
      target: { entityType: "issue", vendorImmutableId: "PAY-99" },
      expectedRevision: "1",
      payload: { value: oversizedValue },
      evidenceIds: []
    })

    assert.isTrue(Result.isFailure(event))
    assert.isTrue(Result.isFailure(action))
  })

  it("keeps authorization evidence separate from an ambiguous dispatch result", () => {
    const negotiated = Schema.decodeUnknownSync(NegotiatedPluginDescriptorV1)({
      descriptor,
      capabilities: [{ capabilityId: "sync.incremental", version: 1 }]
    })
    assert.strictEqual(negotiated.capabilities[0]?.version, 1)

    const authorization = Schema.decodeUnknownResult(AuthorizedPluginActionV1)({
      proposal: {
        proposalKey: "proposal-1",
        capabilityVersion: 1,
        payloadDigest: "0".repeat(64),
        request: {
          actionKind: "transition",
          target: { entityType: "issue", vendorImmutableId: "PAY-42" },
          expectedRevision: "7",
          payload: { status: "Done" },
          evidenceIds: ["evidence-1"]
        },
        summary: "Transition PAY-42",
        impact: { level: "medium", summary: "Changes issue workflow state" },
        proposedAt: observedAt
      },
      idempotencyKey: "action-1",
      payloadDigest: "0".repeat(64),
      authorizationId: "authorization-1",
      authorizedAt: observedAt,
      expiresAt: "2026-07-13T10:05:00.000Z"
    })
    assert.isTrue(Result.isSuccess(authorization))

    const dispatch = Schema.decodeUnknownSync(PluginActionDispatchResultV1)({
      _tag: "unknown",
      reconciliationKey: "reconcile-1",
      safeSummary: "Provider accepted the request but the response was interrupted",
      observedAt
    })
    assert.strictEqual(dispatch._tag, "unknown")
    assert.strictEqual("retryable" in dispatch, false)
  })

  it("binds authorization to the proposal payload digest", () => {
    const authorization = Schema.decodeUnknownResult(AuthorizedPluginActionV1)({
      proposal: {
        proposalKey: "proposal-1",
        capabilityVersion: 1,
        payloadDigest: "0".repeat(64),
        request: {
          actionKind: "transition",
          target: { entityType: "issue", vendorImmutableId: "PAY-42" },
          expectedRevision: "7",
          payload: { status: "Done" },
          evidenceIds: ["evidence-1"]
        },
        summary: "Transition PAY-42",
        impact: { level: "medium", summary: "Changes issue workflow state" },
        proposedAt: observedAt
      },
      idempotencyKey: "action-1",
      payloadDigest: "1".repeat(64),
      authorizationId: "authorization-1",
      authorizedAt: observedAt,
      expiresAt: "2026-07-13T10:05:00.000Z"
    })

    assert.isTrue(Result.isFailure(authorization))
  })

  it("accepts only truthful terminal receipts for completed cancellation", () => {
    const receipt = {
      providerOperationId: "provider-operation-1",
      safeSummary: "Provider response",
      observedAt
    }
    const accepted = Schema.decodeUnknownResult(PluginActionCancellationResultV1)({
      _tag: "completed",
      receipt: { ...receipt, status: "accepted", reconciliationKey: "opaque+token==" }
    })
    const cancelled = Schema.decodeUnknownResult(PluginActionCancellationResultV1)({
      _tag: "completed",
      receipt: { ...receipt, status: "cancelled" }
    })
    const succeeded = Schema.decodeUnknownResult(PluginActionCancellationResultV1)({
      _tag: "completed",
      receipt: { ...receipt, status: "succeeded" }
    })

    assert.isTrue(Result.isFailure(accepted))
    assert.isTrue(Result.isFailure(cancelled))
    assert.isTrue(Result.isSuccess(succeeded))
  })

  it("requires accepted asynchronous work to carry a reconciliation locator", () => {
    const receipt = {
      providerOperationId: "provider-operation-1",
      status: "accepted",
      safeSummary: "Provider accepted asynchronous work",
      observedAt
    }

    assert.isTrue(Result.isFailure(Schema.decodeUnknownResult(PluginProviderReceiptV1)(receipt)))
    assert.isTrue(
      Result.isSuccess(
        Schema.decodeUnknownResult(PluginProviderReceiptV1)({
          ...receipt,
          reconciliationKey: "opaque+token=="
        })
      )
    )
  })

  it("rejects unsafe diff paths and malformed or oversized base64 content", () => {
    for (const path of ["../secret", "/absolute/file", "src/../secret", "src\\secret", "src/\u0000secret"]) {
      assert.isTrue(
        Result.isFailure(
          Schema.decodeUnknownResult(DiffContentRangeRequestV1)({
            entity: { entityType: "pull-request", vendorImmutableId: "42" },
            path,
            previousPath: null,
            status: "modified",
            side: "after",
            offset: 0,
            length: 10
          })
        )
      )
    }

    const invalidBase64 = Schema.decodeUnknownResult(DiffContentRangeV1)({
      bytesBase64: "not base64!",
      totalBytes: 4,
      unavailableReason: null
    })
    const oversizedBase64 = Schema.decodeUnknownResult(DiffContentRangeV1)({
      bytesBase64: Encoding.encodeBase64(new Uint8Array(1_048_577)),
      totalBytes: 1_048_577,
      unavailableReason: null
    })

    assert.isTrue(Result.isFailure(invalidBase64))
    assert.isTrue(Result.isFailure(oversizedBase64))
  })

  it("keeps v1 content identity optional and requires immutable exact identity in v2", () => {
    const legacy = {
      entity: { entityType: "pull-request", vendorImmutableId: "42" },
      path: "src/file.ts",
      side: "after",
      offset: 0,
      length: 10
    }
    assert.isTrue(Result.isSuccess(Schema.decodeUnknownResult(DiffContentRangeRequestV1)(legacy)))
    assert.isTrue(Result.isFailure(Schema.decodeUnknownResult(DiffContentRangeRequestV2)(legacy)))
    assert.isTrue(
      Result.isSuccess(
        Schema.decodeUnknownResult(DiffContentRangeRequestV2)({
          ...legacy,
          expectedRevision: "provider-revision-7",
          baseRevision: "base-commit-7",
          headRevision: "head-commit-7",
          previousPath: null,
          status: "modified"
        })
      )
    )
  })

  it("bounds plugin source URLs before URL decoding", () => {
    const event = Schema.decodeUnknownResult(NormalizedPluginEventV1)({
      _tag: "UpsertEntity",
      eventId: "event-url-oversized",
      observedAt,
      entityType: "issue",
      vendorImmutableId: "PAY-URL",
      revision: "1",
      sourceUrl: `https://provider.example/${"x".repeat(4_096)}`,
      title: "Oversized URL",
      attributes: {}
    })

    assert.isTrue(Result.isFailure(event))
  })
})
