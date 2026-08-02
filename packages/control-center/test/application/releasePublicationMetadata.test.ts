import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

import { SourceRevision } from "../../src/domain/sourceRevision.js"
import { digestReleaseSourceRevisions } from "../../src/server/application/releasePublicationMetadata.js"

const sourceRevision = (revision: string) =>
  Schema.decodeSync(SourceRevision)({
    providerId: "confluence",
    pluginConnectionId: "01890f6f-6d6a-7cc0-98d2-000000000102",
    vendorImmutableId: "space-42",
    revision,
    sourceUrl: null,
    firstObservedAt: "2026-08-03T09:00:00.000Z",
    lastObservedAt: "2026-08-03T09:00:00.000Z",
    synchronizedAt: "2026-08-03T09:00:00.000Z",
    normalizationSchemaVersion: 1
  })

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
})
