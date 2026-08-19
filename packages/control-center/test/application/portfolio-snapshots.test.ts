import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

import { GovernedActionEnvelopeDigest } from "../../src/domain/governedAction/index.js"
import { GovernedActionId, PluginConnectionId, ReleaseId, WorkspaceId } from "../../src/domain/identifiers.js"
import { Release } from "../../src/domain/release.js"
import { deriveReleaseRelay } from "../../src/domain/releaseRelay.js"
import {
  classifyReleasePublicationAwareness,
  loadReleasePageAwareness
} from "../../src/server/application/portfolioSnapshots.js"
import { PersistedRecordError } from "../../src/server/persistence/errors.js"
import {
  GovernedActionReleasePublicationReadInput
} from "../../src/server/persistence/repositories/governed-action/contract.js"

const WORKSPACE_ID = WorkspaceId.make("01890f6f-6d6a-7cc0-98d2-510000000001")
const PLUGIN_CONNECTION_ID = PluginConnectionId.make("01890f6f-6d6a-7cc0-98d2-510000000002")
const UPDATED_AT = "2026-08-03T08:00:00.000Z"
const SOURCE_REVISION_DIGEST = GovernedActionEnvelopeDigest.make(`sha256:${"a".repeat(64)}`)

const makeRelease = (index: number): Release => {
  const releaseId = ReleaseId.make(
    `01890f6f-6d6a-7cc0-98d2-${String(index + 1).padStart(12, "0")}`
  )
  return Schema.decodeUnknownSync(Release)({
    createdAt: UPDATED_AT,
    freshness: {
      _tag: "missing",
      pluginHealth: { _tag: "healthy", checkedAt: UPDATED_AT },
      provenance: { _tag: "none", pluginConnectionId: PLUGIN_CONNECTION_ID },
      sourceObservedAt: null,
      staleAfterSeconds: 300,
      synchronizedAt: UPDATED_AT
    },
    id: releaseId,
    lifecycle: "candidate",
    relay: deriveReleaseRelay(releaseId),
    roleAssignments: [],
    serviceName: `service-${index}`,
    sourceRevisions: [],
    targetEnvironmentIds: [],
    updatedAt: UPDATED_AT,
    version: `1.0.${index}`,
    workspaceId: WORKSPACE_ID
  })
}

type PublicationHistory = Parameters<typeof loadReleasePageAwareness>[0]

describe("portfolio publication awareness", () => {
  it("fails closed for an unparseable successful receipt and accepts a canonical locator", () => {
    const release = makeRelease(0)
    const candidate = {
      actionId: GovernedActionId.make("01890f6f-6d6a-7cc0-98d2-510000000003"),
      releaseId: release.id,
      pluginConnectionId: PLUGIN_CONNECTION_ID,
      occurredAt: release.updatedAt,
      sourceRevisionDigest: SOURCE_REVISION_DIGEST
    }

    assert.deepStrictEqual(
      classifyReleasePublicationAwareness(release, [{
        ...candidate,
        providerOperationId: "confluence-page:page-1:v1"
      }], SOURCE_REVISION_DIGEST),
      { state: "unknown", lastPublishedAt: null }
    )
    assert.deepStrictEqual(
      classifyReleasePublicationAwareness(release, [{
        ...candidate,
        providerOperationId: "confluence-page:42:v2"
      }], SOURCE_REVISION_DIGEST),
      {
        state: "current",
        lastPublishedAt: release.updatedAt,
        publicationActionId: candidate.actionId
      }
    )
  })

  it("uses semantic source revisions instead of synchronization timestamps for staleness", () => {
    const release = Release.make({
      ...makeRelease(0),
      updatedAt: Schema.decodeUnknownSync(Release.fields.updatedAt)("2026-08-03T09:00:00.000Z")
    })
    const candidate = {
      actionId: GovernedActionId.make("01890f6f-6d6a-7cc0-98d2-510000000003"),
      releaseId: release.id,
      pluginConnectionId: PLUGIN_CONNECTION_ID,
      occurredAt: Schema.decodeUnknownSync(Release.fields.updatedAt)(UPDATED_AT),
      providerOperationId: "confluence-page:42:v2",
      sourceRevisionDigest: SOURCE_REVISION_DIGEST
    }

    assert.strictEqual(
      classifyReleasePublicationAwareness(release, [candidate], SOURCE_REVISION_DIGEST).state,
      "current"
    )
    assert.strictEqual(
      classifyReleasePublicationAwareness(
        release,
        [candidate],
        GovernedActionEnvelopeDigest.make(`sha256:${"b".repeat(64)}`)
      ).state,
      "stale"
    )
  })

  it.effect("uses one batched history read for 200 releases without entity fan-out", () =>
    Effect.gen(function*() {
      const releases = Array.from({ length: 200 }, (_, index) => makeRelease(index))
      const calls: Array<GovernedActionReleasePublicationReadInput> = []
      const history: PublicationHistory = {
        readLatestTerminalReleasePublications: (input) =>
          Effect.sync(() => {
            calls.push(Schema.decodeUnknownSync(GovernedActionReleasePublicationReadInput)(input))
            return []
          })
      }

      const awareness = yield* loadReleasePageAwareness(history, releases)

      assert.lengthOf(calls, 1)
      assert.lengthOf(calls[0]?.releaseIds ?? [], 200)
      assert.strictEqual(awareness.size, 200)
      assert.isTrue(Array.from(awareness.values()).every(({ state }) => state === "not-published"))
    }).pipe(Effect.provide(NodeCrypto.layer)))

  it.effect("reports unknown when the batched publication history cannot be trusted", () =>
    Effect.gen(function*() {
      const releases = [makeRelease(0)]
      const release = releases[0]
      if (release === undefined) return yield* Effect.die("release fixture is missing")
      const history: PublicationHistory = {
        readLatestTerminalReleasePublications: () =>
          Effect.fail(
            new PersistedRecordError({
              workspaceId: WORKSPACE_ID,
              recordKind: "governed-action",
              recordKey: release.id,
              diagnosticCode: "governed-action-schema-invalid"
            })
          )
      }

      const awareness = yield* loadReleasePageAwareness(history, releases)

      assert.deepStrictEqual(awareness.get(release.id), {
        state: "unknown",
        lastPublishedAt: null
      })
    }).pipe(Effect.provide(NodeCrypto.layer)))
})
