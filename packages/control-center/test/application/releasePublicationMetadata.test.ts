import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

import { ReleaseId } from "../../src/domain/identifiers.js"
import { SourceRevision } from "../../src/domain/sourceRevision.js"
import { UtcTimestamp } from "../../src/domain/utcTimestamp.js"
import {
  digestReleaseSourceRevisions,
  latestConfluencePublicationReference,
  matchesConfluencePublicationReference
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

  it("binds a Confluence update to the exact latest successful release-page receipt", () => {
    const releaseId = ReleaseId.make("01890f6f-6d6a-7cc0-98d2-000000000103")
    const otherReleaseId = ReleaseId.make("01890f6f-6d6a-7cc0-98d2-000000000104")
    const published = latestConfluencePublicationReference([
      {
        releaseId,
        occurredAt: timestamp("2026-08-03T09:00:00.000Z"),
        providerOperationId: "confluence-page:42"
      },
      {
        releaseId,
        occurredAt: timestamp("2026-08-03T10:00:00.000Z"),
        providerOperationId: "confluence-page:42:v2"
      },
      {
        releaseId: otherReleaseId,
        occurredAt: timestamp("2026-08-03T11:00:00.000Z"),
        providerOperationId: "confluence-page:99:v7"
      }
    ], releaseId)

    assert.deepStrictEqual(published, {
      pageId: "42",
      pageVersion: 2,
      publishedAt: timestamp("2026-08-03T10:00:00.000Z")
    })
    assert.isTrue(matchesConfluencePublicationReference(published, { pageId: "42", pageVersion: 2 }))
    assert.isFalse(matchesConfluencePublicationReference(published, { pageId: "99", pageVersion: 7 }))
    assert.isFalse(matchesConfluencePublicationReference(published, { pageId: "42", pageVersion: 3 }))
  })
})
