import { assert, describe, it } from "@effect/vitest"
import { DateTime, Effect, Result, Schema } from "effect"

import { ProviderId, Revision, SourceRevision, SourceUrl, VendorImmutableId } from "../../src/domain/sourceRevision.js"

const sourceRevisionInput = {
  providerId: "jira",
  pluginConnectionId: "01890f6f-6d6a-7cc0-98d2-000000000001",
  vendorImmutableId: "10042",
  revision: "etag/\"ABC-42\":7",
  sourceUrl: "https://example.atlassian.net/browse/ABC-42",
  firstObservedAt: "2026-07-13T08:00:00.000Z",
  lastObservedAt: "2026-07-13T08:05:00.000Z",
  synchronizedAt: "2026-07-13T08:06:00.000Z",
  normalizationSchemaVersion: 1
} satisfies typeof SourceRevision.Encoded

describe("ProviderId", () => {
  it.each(["codecommit", "codepipeline", "jira", "confluence", "clockify"])(
    "preserves the explicit provider ID %s",
    (providerId) => {
      const decoded = Schema.decodeUnknownResult(ProviderId)(providerId)

      assert.isTrue(Result.isSuccess(decoded))
    }
  )

  it.each(["ccmt", "jr", "cnflnc", "github", "JIRA"])(
    "rejects unsupported or abbreviated provider ID %s",
    (providerId) => {
      const decoded = Schema.decodeUnknownResult(ProviderId)(providerId)

      assert.isTrue(Result.isFailure(decoded))
    }
  )
})

describe("opaque source values", () => {
  it("preserves provider-specific punctuation", () => {
    assert.isTrue(Result.isSuccess(Schema.decodeUnknownResult(VendorImmutableId)("ari:cloud:jira::issue/10042")))
    assert.isTrue(Result.isSuccess(Schema.decodeUnknownResult(Revision)("W/\"opaque:revision/42\"")))
  })

  it.each(["", " leading", "trailing ", " ", "x".repeat(513)])("rejects an invalid bounded opaque value", (value) => {
    assert.isTrue(Result.isFailure(Schema.decodeUnknownResult(VendorImmutableId)(value)))
    assert.isTrue(Result.isFailure(Schema.decodeUnknownResult(Revision)(value)))
  })
})

describe("SourceRevision", () => {
  it.effect("decodes provenance and round-trips its encoded representation", () =>
    Effect.gen(function*() {
      const sourceRevision = yield* Schema.decodeUnknownEffect(SourceRevision)(sourceRevisionInput)
      const encoded = yield* Schema.encodeEffect(SourceRevision)(sourceRevision)
      const decodedAgain = yield* Schema.decodeUnknownEffect(SourceRevision)(encoded)

      assert.deepStrictEqual(encoded, sourceRevisionInput)
      assert.strictEqual(decodedAgain.providerId, sourceRevision.providerId)
      assert.strictEqual(decodedAgain.vendorImmutableId, sourceRevision.vendorImmutableId)
      assert.strictEqual(decodedAgain.revision, sourceRevision.revision)
      assert.strictEqual(decodedAgain.sourceUrl?.href, sourceRevision.sourceUrl?.href)
      assert.strictEqual(
        DateTime.toEpochMillis(decodedAgain.firstObservedAt),
        DateTime.toEpochMillis(sourceRevision.firstObservedAt)
      )
      assert.strictEqual(
        DateTime.toEpochMillis(decodedAgain.lastObservedAt),
        DateTime.toEpochMillis(sourceRevision.lastObservedAt)
      )
      assert.strictEqual(
        DateTime.toEpochMillis(decodedAgain.synchronizedAt),
        DateTime.toEpochMillis(sourceRevision.synchronizedAt)
      )
    }))

  it.effect("accepts an absent provider URL and equal observation times", () =>
    Effect.gen(function*() {
      const sourceRevision = yield* Schema.decodeUnknownEffect(SourceRevision)({
        ...sourceRevisionInput,
        sourceUrl: null,
        lastObservedAt: sourceRevisionInput.firstObservedAt
      })

      assert.strictEqual(sourceRevision.sourceUrl, null)
    }))

  it("rejects a last observation before the first observation", () => {
    const decoded = Schema.decodeUnknownResult(SourceRevision)({
      ...sourceRevisionInput,
      firstObservedAt: "2026-07-13T08:05:00.000Z",
      lastObservedAt: "2026-07-13T08:00:00.000Z"
    })

    assert.isTrue(Result.isFailure(decoded))
  })

  it("rejects synchronization before the last observation", () => {
    const decoded = Schema.decodeUnknownResult(SourceRevision)({
      ...sourceRevisionInput,
      lastObservedAt: "2026-07-13T08:10:00.000Z",
      synchronizedAt: "2026-07-13T08:09:00.000Z"
    })

    assert.isTrue(Result.isFailure(decoded))
  })

  it.each([0, -1, 1.5])("rejects normalization schema version %s", (normalizationSchemaVersion) => {
    const decoded = Schema.decodeUnknownResult(SourceRevision)({
      ...sourceRevisionInput,
      normalizationSchemaVersion
    })

    assert.isTrue(Result.isFailure(decoded))
  })

  it("rejects an invalid source URL", () => {
    const decoded = Schema.decodeUnknownResult(SourceRevision)({
      ...sourceRevisionInput,
      sourceUrl: "not a URL"
    })

    assert.isTrue(Result.isFailure(decoded))
  })

  it.each([
    "javascript:alert(1)",
    "data:text/html,unsafe",
    "file:///etc/passwd",
    "https://user:secret@example.com/object",
    "https://example.com/a\nb",
    "https://example.com/a\rb",
    "https://example.com/a\tb",
    "https://example.com/a\u0000b",
    "https://example.com/a\u001fb",
    "https://example.com/a\u007fb",
    "https://example.com/a\u0085b"
  ])("rejects unsafe source URL %s", (sourceUrl) => {
    assert.isTrue(Result.isFailure(Schema.decodeUnknownResult(SourceUrl)(sourceUrl)))
    assert.isTrue(
      Result.isFailure(
        Schema.decodeUnknownResult(SourceRevision)({
          ...sourceRevisionInput,
          sourceUrl
        })
      )
    )
  })

  it.each(["https://example.com/object", "http://localhost:8080/object"])(
    "accepts navigable source URL %s",
    (sourceUrl) => {
      assert.isTrue(Result.isSuccess(Schema.decodeUnknownResult(SourceUrl)(sourceUrl)))
    }
  )

  it.effect.prop(
    "round-trips every generated valid source revision",
    [SourceRevision],
    ([sourceRevision]) =>
      Effect.gen(function*() {
        const encoded = yield* Schema.encodeEffect(SourceRevision)(sourceRevision)
        const decoded = yield* Schema.decodeUnknownEffect(SourceRevision)(encoded)

        assert.strictEqual(decoded.providerId, sourceRevision.providerId)
        assert.strictEqual(decoded.pluginConnectionId, sourceRevision.pluginConnectionId)
        assert.strictEqual(decoded.vendorImmutableId, sourceRevision.vendorImmutableId)
        assert.strictEqual(decoded.revision, sourceRevision.revision)
        assert.strictEqual(decoded.normalizationSchemaVersion, sourceRevision.normalizationSchemaVersion)
        assert.strictEqual(decoded.sourceUrl?.href, sourceRevision.sourceUrl?.href)
        assert.strictEqual(
          DateTime.toEpochMillis(decoded.firstObservedAt),
          DateTime.toEpochMillis(sourceRevision.firstObservedAt)
        )
        assert.strictEqual(
          DateTime.toEpochMillis(decoded.lastObservedAt),
          DateTime.toEpochMillis(sourceRevision.lastObservedAt)
        )
        assert.strictEqual(
          DateTime.toEpochMillis(decoded.synchronizedAt),
          DateTime.toEpochMillis(sourceRevision.synchronizedAt)
        )
      })
  )
})
