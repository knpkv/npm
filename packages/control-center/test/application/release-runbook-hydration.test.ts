import { assert, describe, it } from "@effect/vitest"

import type { ReleaseDeliveryGraphInspection } from "../../src/api/deliveryGraph.js"
import { releaseRunbookEntityIds } from "../../src/server/application/releaseRunbookHydration.js"
import { releaseWorksetFixture } from "../fixtures/releaseWorkset.js"

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
})
