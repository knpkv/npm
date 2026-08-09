import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

import type { ReleaseDeliveryGraphInspection } from "../../src/api/deliveryGraph.js"
import type { WorkspaceId } from "../../src/domain/identifiers.js"
import {
  hydrateReleaseRunbookContent,
  releaseRunbookEntityIds
} from "../../src/server/application/releaseRunbookHydration.js"
import {
  DeliveryGraphQuery,
  DeliveryGraphReadResult
} from "../../src/server/persistence/repositories/delivery-graph/contract.js"
import { releaseWorksetFixture, WORKSET_WORKSPACE_ID } from "../fixtures/releaseWorkset.js"

describe("release runbook hydration", () => {
  it("selects the unique page directly documenting the inspected release", () => {
    const page = releaseWorksetFixture.entityProjections.find(
      ({ projection }) => projection.details._tag === "page"
    )
    if (page === undefined) throw new Error("Expected a release runbook fixture")

    const duplicateRelationship: ReleaseDeliveryGraphInspection = {
      ...releaseWorksetFixture,
      relationships: [
        ...releaseWorksetFixture.relationships,
        ...releaseWorksetFixture.relationships.filter(({ kind }) => kind === "documented-by")
      ]
    }

    assert.deepStrictEqual(releaseRunbookEntityIds(duplicateRelationship), [page.projection.entityId])
  })

  it("excludes rejected release-to-page relationships", () => {
    const rejected: ReleaseDeliveryGraphInspection = {
      ...releaseWorksetFixture,
      relationships: releaseWorksetFixture.relationships.map((relationship) =>
        relationship.kind === "documented-by"
          ? {
            ...relationship,
            lifecycle: {
              _tag: "rejected",
              effectiveAt: relationship.recordedAt,
              reason: "The page no longer documents this release."
            }
          }
          : relationship
      )
    }

    assert.deepStrictEqual(releaseRunbookEntityIds(rejected), [])
  })

  it.effect("replaces the bounded runbook summary with the exact persisted page", () =>
    Effect.gen(function*() {
      const page = releaseWorksetFixture.entityProjections.find(
        ({ projection }) => projection.details._tag === "page"
      )
      if (page?.projection.details._tag !== "page") {
        return yield* Effect.die("Expected a release runbook fixture")
      }
      const summary: typeof page = {
        ...page,
        projection: {
          ...page.projection,
          details: { ...page.projection.details, content: null, contentState: "lazy" }
        }
      }
      const exact: typeof page = {
        ...page,
        projection: {
          ...page.projection,
          details: {
            ...page.projection.details,
            content: {
              representation: "safe-markdown",
              markdown: "- \\[x\\] Hydrated release task\n"
            },
            contentState: "loaded"
          }
        }
      }
      const reads = new Array<{ readonly entityId: string; readonly workspaceId: string }>()
      const persistence = {
        deliveryGraph: {
          read: (workspaceId: WorkspaceId, input: unknown) =>
            Effect.gen(function*() {
              const query = yield* Schema.decodeUnknownEffect(DeliveryGraphQuery)(input).pipe(
                Effect.orDie
              )
              if (workspaceId !== WORKSET_WORKSPACE_ID || query._tag !== "entitySlice") {
                return yield* Effect.die("Expected one exact runbook entity read")
              }
              reads.push({ entityId: query.entityId, workspaceId })
              return DeliveryGraphReadResult.make({
                _tag: "entitySlice",
                value: {
                  entity: {
                    canonicalReleaseId: releaseWorksetFixture.releaseId,
                    owners: [],
                    ownersTruncated: false,
                    releaseIds: [releaseWorksetFixture.releaseId],
                    releaseMembershipsTruncated: false,
                    ...exact
                  },
                  truncated: false,
                  nodes: [],
                  relatedEntityProjections: [],
                  relationships: [],
                  evidenceClaims: [],
                  evidenceItems: []
                }
              })
            })
        }
      }
      const inspection: ReleaseDeliveryGraphInspection = {
        ...releaseWorksetFixture,
        entityProjections: releaseWorksetFixture.entityProjections.map((entry) =>
          entry.projection.entityId === summary.projection.entityId ? summary : entry
        )
      }

      const hydrated = yield* hydrateReleaseRunbookContent(
        persistence,
        WORKSET_WORKSPACE_ID,
        inspection
      )

      assert.deepStrictEqual(reads, [{
        entityId: exact.projection.entityId,
        workspaceId: WORKSET_WORKSPACE_ID
      }])
      assert.deepStrictEqual(
        hydrated.entityProjections.find(
          ({ projection }) => projection.entityId === exact.projection.entityId
        ),
        exact
      )
    }))
})
