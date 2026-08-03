import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

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
      occurredAt: release.updatedAt
    }

    assert.deepStrictEqual(
      classifyReleasePublicationAwareness(release, [{
        ...candidate,
        providerOperationId: "confluence-page:page-1:v1"
      }]),
      { state: "unknown", lastPublishedAt: null }
    )
    assert.deepStrictEqual(
      classifyReleasePublicationAwareness(release, [{
        ...candidate,
        providerOperationId: "confluence-page:42:v2"
      }]),
      {
        state: "current",
        lastPublishedAt: release.updatedAt,
        publicationActionId: candidate.actionId
      }
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
    }))

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
    }))
})
