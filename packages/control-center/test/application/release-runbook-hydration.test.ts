import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

import { ReleaseDeliveryGraphInspection } from "../../src/api/deliveryGraph.js"
import { EntityId, GraphNodeId, RelationshipId, type WorkspaceId } from "../../src/domain/identifiers.js"
import { releaseConfluenceTaskReadiness } from "../../src/server/application/releasePublicationSubmissions.js"
import {
  hydrateReleaseRunbookContent,
  MAXIMUM_HYDRATED_RELEASE_RUNBOOK_CHARACTERS,
  MAXIMUM_HYDRATED_RELEASE_RUNBOOKS,
  releaseRunbookEntityIds
} from "../../src/server/application/releaseRunbookHydration.js"
import {
  DeliveryGraphQuery,
  DeliveryGraphReadResult
} from "../../src/server/persistence/repositories/delivery-graph/contract.js"
import { releaseWorksetFixture, WORKSET_WORKSPACE_ID } from "../fixtures/releaseWorkset.js"

const maximumRunbookInspection = (): ReleaseDeliveryGraphInspection => {
  const page = releaseWorksetFixture.entityProjections.find(
    ({ projection }) => projection.details._tag === "page"
  )
  const pageNode = releaseWorksetFixture.nodes.find(
    (node) =>
      node.resolution._tag === "resolved" && node.resolution.target._tag === "entity" &&
      node.resolution.target.entityKind === "page"
  )
  const releaseNode = releaseWorksetFixture.nodes.find(
    (node) => node.resolution._tag === "resolved" && node.resolution.target._tag === "release"
  )
  const documentedBy = releaseWorksetFixture.relationships.find(
    (relationship) => relationship.kind === "documented-by"
  )
  if (page === undefined || pageNode === undefined || releaseNode === undefined || documentedBy === undefined) {
    throw new Error("Expected release runbook fixtures")
  }
  const uuid = (group: number, ordinal: number): string =>
    `01890f6f-6d6a-7cc0-98d${String(group)}-${String(ordinal).padStart(12, "0")}`
  const runbooks = Array.from({ length: 499 }, (_, index) => {
    const entityId = Schema.decodeUnknownSync(EntityId)(uuid(6, index + 1))
    const nodeId = Schema.decodeUnknownSync(GraphNodeId)(uuid(7, index + 1))
    return {
      projection: {
        ...page,
        projection: {
          ...page.projection,
          entityId,
          displayKey: `PAY/RUNBOOK-${String(index + 1)}`,
          details: page.projection.details._tag === "page"
            ? { ...page.projection.details, content: null, contentState: "lazy" }
            : page.projection.details
        }
      },
      node: {
        ...pageNode,
        nodeId,
        resolution: {
          _tag: "resolved",
          target: { _tag: "entity", entityId, entityKind: "page" }
        }
      },
      relationship: {
        ...documentedBy,
        relationshipId: Schema.decodeUnknownSync(RelationshipId)(uuid(8, index + 1)),
        targetNodeId: nodeId
      }
    }
  })
  return Schema.decodeUnknownSync(Schema.toType(ReleaseDeliveryGraphInspection))({
    ...releaseWorksetFixture,
    truncated: false,
    entityProjections: runbooks.map(({ projection }) => projection),
    nodes: [releaseNode, ...runbooks.map(({ node }) => node)],
    relationships: runbooks.map(({ relationship }) => relationship),
    evidenceClaims: [],
    evidenceItems: []
  })
}

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
              if (workspaceId !== WORKSET_WORKSPACE_ID || query._tag !== "entityProjection") {
                return yield* Effect.die("Expected one exact runbook projection read")
              }
              reads.push({ entityId: query.entityId, workspaceId })
              return DeliveryGraphReadResult.make({
                _tag: "entityProjection",
                value: exact
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
      assert.isFalse(hydrated.truncated)
    }))

  it.effect("bounds aggregate exact runbook content and leaves the release unverifiable", () =>
    Effect.gen(function*() {
      const inspection = maximumRunbookInspection()
      const maximumBody = "x".repeat(262_144)
      const pageByEntityId = new Map(
        inspection.entityProjections.map((entry) => [entry.projection.entityId, entry])
      )
      let reads = 0
      const persistence = {
        deliveryGraph: {
          read: (_workspaceId: WorkspaceId, input: unknown) =>
            Effect.gen(function*() {
              const query = yield* Schema.decodeUnknownEffect(DeliveryGraphQuery)(input).pipe(Effect.orDie)
              if (query._tag !== "entityProjection") {
                return yield* Effect.die("Expected an exact runbook projection read")
              }
              const page = pageByEntityId.get(query.entityId)
              if (page?.projection.details._tag !== "page") {
                return yield* Effect.die("Expected a bounded runbook projection")
              }
              reads += 1
              return DeliveryGraphReadResult.make({
                _tag: "entityProjection",
                value: {
                  ...page,
                  projection: {
                    ...page.projection,
                    details: {
                      ...page.projection.details,
                      content: { representation: "safe-markdown", markdown: maximumBody },
                      contentState: "loaded"
                    }
                  }
                }
              })
            })
        }
      }

      const hydrated = yield* hydrateReleaseRunbookContent(
        persistence,
        WORKSET_WORKSPACE_ID,
        inspection
      )
      const hydratedCharacters = hydrated.entityProjections.reduce(
        (total, { projection }) =>
          total + (projection.details._tag === "page" ? projection.details.content?.markdown.length ?? 0 : 0),
        0
      )

      assert.isAtMost(reads, MAXIMUM_HYDRATED_RELEASE_RUNBOOKS)
      assert.isAtMost(hydratedCharacters, MAXIMUM_HYDRATED_RELEASE_RUNBOOK_CHARACTERS)
      assert.isTrue(hydrated.truncated)
      assert.isFalse(releaseConfluenceTaskReadiness(hydrated).ready)
    }))

  it.effect("preserves a deleted runbook as unverifiable without reading its exact slice", () =>
    Effect.gen(function*() {
      const page = releaseWorksetFixture.entityProjections.find(
        ({ projection }) => projection.details._tag === "page"
      )
      if (page === undefined) return yield* Effect.die("Expected a release runbook fixture")
      const deleted: typeof page = {
        ...page,
        projection: { ...page.projection, entityState: "deleted" }
      }
      const inspection: ReleaseDeliveryGraphInspection = {
        ...releaseWorksetFixture,
        entityProjections: releaseWorksetFixture.entityProjections.map((entry) =>
          entry.projection.entityId === deleted.projection.entityId ? deleted : entry
        )
      }
      const persistence = {
        deliveryGraph: {
          read: (_workspaceId: WorkspaceId, _input: unknown) =>
            Effect.die("Deleted release runbooks must not request an exact entity slice")
        }
      }

      const hydrated = yield* hydrateReleaseRunbookContent(
        persistence,
        WORKSET_WORKSPACE_ID,
        inspection
      )

      assert.deepStrictEqual(hydrated, inspection)
      assert.deepStrictEqual(releaseConfluenceTaskReadiness(hydrated), {
        completed: 0,
        outstanding: 0,
        ready: false,
        total: 0,
        unverifiablePages: 1
      })
    }))
})
