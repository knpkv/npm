import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

import { EntityId, PluginConnectionId, ReleaseId } from "../../src/domain/identifiers.js"
import { SourceRevision } from "../../src/domain/sourceRevision.js"
import { UtcTimestamp } from "../../src/domain/utcTimestamp.js"
import {
  digestReleaseSourceRevisions,
  latestConfluencePublicationReference,
  matchesConfluencePublicationReference,
  releasePublicationTargetEntityId,
  selectReleasePublicationConnection
} from "../../src/server/application/releasePublicationMetadata.js"

const sourceRevision = (
  revision: string,
  timestamps = {
    firstObservedAt: "2026-08-03T09:00:00.000Z",
    lastObservedAt: "2026-08-03T09:00:00.000Z",
    synchronizedAt: "2026-08-03T09:00:00.000Z"
  }
) =>
  Schema.decodeSync(SourceRevision)({
    providerId: "confluence",
    pluginConnectionId: "01890f6f-6d6a-7cc0-98d2-000000000102",
    vendorImmutableId: "space-42",
    revision,
    sourceUrl: null,
    ...timestamps,
    normalizationSchemaVersion: 1
  })

const timestamp = (value: string) => Schema.decodeSync(UtcTimestamp)(value)

describe("release publication metadata", () => {
  it("binds the publication baseline to the exact source revision snapshot", async () => {
    const initial = await Effect.runPromise(
      digestReleaseSourceRevisions([sourceRevision("page-v1")]).pipe(Effect.provide(NodeCrypto.layer))
    )
    const changed = await Effect.runPromise(
      digestReleaseSourceRevisions([sourceRevision("page-v2")]).pipe(Effect.provide(NodeCrypto.layer))
    )

    assert.match(initial, /^sha256:[0-9a-f]{64}$/u)
    assert.notEqual(initial, changed)
  })

  it("keeps publication identity stable across observation-only synchronization", async () => {
    const initial = await Effect.runPromise(
      digestReleaseSourceRevisions([sourceRevision("page-v1")]).pipe(Effect.provide(NodeCrypto.layer))
    )
    const synchronizedAgain = await Effect.runPromise(
      digestReleaseSourceRevisions([
        sourceRevision("page-v1", {
          firstObservedAt: "2026-08-03T09:00:00.000Z",
          lastObservedAt: "2026-08-03T10:00:00.000Z",
          synchronizedAt: "2026-08-03T10:01:00.000Z"
        })
      ]).pipe(Effect.provide(NodeCrypto.layer))
    )

    assert.strictEqual(initial, synchronizedAgain)
  })

  it("canonicalizes source order independently of locale-sensitive revision text", async () => {
    const forward = await Effect.runPromise(
      digestReleaseSourceRevisions([sourceRevision("ä"), sourceRevision("z")]).pipe(
        Effect.provide(NodeCrypto.layer)
      )
    )
    const reversed = await Effect.runPromise(
      digestReleaseSourceRevisions([sourceRevision("z"), sourceRevision("ä")]).pipe(
        Effect.provide(NodeCrypto.layer)
      )
    )

    assert.strictEqual(forward, reversed)
  })

  it("binds a Confluence update to the exact latest successful release-page receipt", () => {
    const releaseId = ReleaseId.make("01890f6f-6d6a-7cc0-98d2-000000000103")
    const otherReleaseId = ReleaseId.make("01890f6f-6d6a-7cc0-98d2-000000000104")
    const connectionId = PluginConnectionId.make("01890f6f-6d6a-7cc0-98d2-000000000102")
    const otherConnectionId = PluginConnectionId.make("01890f6f-6d6a-7cc0-98d2-000000000105")
    const published = latestConfluencePublicationReference([
      {
        releaseId,
        pluginConnectionId: connectionId,
        occurredAt: timestamp("2026-08-03T09:00:00.000Z"),
        providerOperationId: "confluence-page:42"
      },
      {
        releaseId,
        pluginConnectionId: connectionId,
        occurredAt: timestamp("2026-08-03T10:00:00.000Z"),
        providerOperationId: "confluence-page:42:v2"
      },
      {
        releaseId: otherReleaseId,
        pluginConnectionId: otherConnectionId,
        occurredAt: timestamp("2026-08-03T11:00:00.000Z"),
        providerOperationId: "confluence-page:99:v7"
      }
    ], releaseId)

    assert.deepStrictEqual(published, {
      pageId: "42",
      pageVersion: 2,
      pluginConnectionId: connectionId,
      publishedAt: timestamp("2026-08-03T10:00:00.000Z")
    })
    assert.isTrue(matchesConfluencePublicationReference(published, { pageId: "42", pageVersion: 2 }))
    assert.isFalse(matchesConfluencePublicationReference(published, { pageId: "99", pageVersion: 7 }))
    assert.isFalse(matchesConfluencePublicationReference(published, { pageId: "42", pageVersion: 3 }))
  })

  it("routes updates to their receipt connection and rejects ambiguous creates", () => {
    const connectionA = PluginConnectionId.make("01890f6f-6d6a-7cc0-98d2-000000000102")
    const connectionB = PluginConnectionId.make("01890f6f-6d6a-7cc0-98d2-000000000105")

    assert.deepStrictEqual(
      selectReleasePublicationConnection({
        enabledConnectionIds: [connectionA, connectionB],
        publicationReceiptConnectionId: connectionB
      }),
      { _tag: "selected", pluginConnectionId: connectionB }
    )
    assert.deepStrictEqual(
      selectReleasePublicationConnection({
        enabledConnectionIds: [connectionA]
      }),
      { _tag: "selected", pluginConnectionId: connectionA }
    )
    assert.deepStrictEqual(
      selectReleasePublicationConnection({
        enabledConnectionIds: [connectionA, connectionB]
      }),
      { _tag: "ambiguous" }
    )
  })

  it("anchors the first publication to the release without requiring a synchronized destination entity", () => {
    const releaseId = ReleaseId.make("01890f6f-6d6a-7cc0-98d2-000000000103")
    const connectionId = PluginConnectionId.make("01890f6f-6d6a-7cc0-98d2-000000000102")

    assert.strictEqual(
      releasePublicationTargetEntityId(releaseId),
      EntityId.make("01890f6f-6d6a-7cc0-98d2-000000000103")
    )
    assert.deepStrictEqual(
      selectReleasePublicationConnection({ enabledConnectionIds: [connectionId] }),
      { _tag: "selected", pluginConnectionId: connectionId }
    )
  })
})
