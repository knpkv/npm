import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"

import { workspaceEntityStateForHref } from "../../src/client/entities/WorkspaceEntityLink.js"
import {
  decodeEntityRouteId,
  entityOriginFromLocation,
  isSafeWorkspaceEntityOrigin,
  makeWorkspaceEntityRouteState,
  resolveWorkspaceEntityOrigin,
  workspaceEntityAgentPath,
  workspaceEntityOriginAgentPath,
  workspaceEntityOriginHref,
  workspaceEntityParentPath,
  workspaceEntityPath,
  workspaceEntityTargetFromHref
} from "../../src/client/items/workspaceEntityRoutes.js"
import { makeReleaseRouteState, readReleaseOrigin } from "../../src/client/releases/releaseRoutes.js"
import { EntityId, ReleaseId, WorkspaceId } from "../../src/domain/identifiers.js"

const workspaceId = Schema.decodeUnknownSync(WorkspaceId)("01890f6f-6d6a-7cc0-98d2-000000000001")
const otherWorkspaceId = Schema.decodeUnknownSync(WorkspaceId)("01890f6f-6d6a-7cc0-98d2-000000000002")
const entityId = Schema.decodeUnknownSync(EntityId)("01890f6f-6d6a-7cc0-98d3-000000000001")
const relatedEntityId = Schema.decodeUnknownSync(EntityId)("01890f6f-6d6a-7cc0-98d3-000000000002")
const releaseId = Schema.decodeUnknownSync(ReleaseId)("01890f6f-6d6a-7cc0-98d4-000000000001")
const otherReleaseId = Schema.decodeUnknownSync(ReleaseId)("01890f6f-6d6a-7cc0-98d4-000000000002")

const releaseContext = (releaseIds: ReadonlyArray<typeof releaseId>, canonicalReleaseId = releaseIds[0] ?? null) => ({
  canonicalReleaseId,
  releaseIds,
  releaseMembershipsTruncated: false
})

describe("workspace entity routes", () => {
  it("builds and decodes the canonical entity path", () => {
    const href = `/w/${workspaceId}/items/${entityId}`
    expect(workspaceEntityParentPath(workspaceId)).toBe(`/w/${workspaceId}/items`)
    expect(workspaceEntityPath(workspaceId, entityId)).toBe(href)
    expect(workspaceEntityTargetFromHref(href)).toEqual({ entityId, workspaceId })
    expect(decodeEntityRouteId(entityId)).toBe(entityId)
    expect(decodeEntityRouteId("not-an-entity")).toBeNull()
  })

  it.each([
    `/w/${workspaceId}/items/${entityId}?from=timeline`,
    `/w/${workspaceId}/items/${entityId}#relationships`,
    `/w/${workspaceId}/items/${entityId}/activity`,
    `/w/${workspaceId}/releases/${releaseId}`,
    `/w/not-a-workspace/items/${entityId}`,
    `/w/${workspaceId}/items/not-an-entity`,
    `https://control.example.test/w/${workspaceId}/items/${entityId}`
  ])("rejects noncanonical entity href %s", (href) => {
    expect(workspaceEntityTargetFromHref(href)).toBeNull()
  })

  it.each([
    ["Overview", `/w/${workspaceId}/overview`],
    ["Active work", `/w/${workspaceId}/work`],
    ["Items", `/w/${workspaceId}/items`],
    ["Timeline", `/w/${workspaceId}/timeline`],
    ["Release", `/w/${workspaceId}/releases/${releaseId}`],
    ["Release preview", `/w/${workspaceId}/releases/${releaseId}/preview`]
  ])("round-trips an exact %s origin", (_label, pathname) => {
    const origin = entityOriginFromLocation({ hash: "#selection", pathname, search: "?filter=attention" })
    const state = makeWorkspaceEntityRouteState(null, workspaceId, entityId, origin)

    expect(resolveWorkspaceEntityOrigin(state, workspaceId, entityId)).toEqual({ isStored: true, origin })
    expect(workspaceEntityOriginHref(origin)).toBe(`${pathname}?filter=attention#selection`)
  })

  it("preserves existing route state and carries the root origin through related entities", () => {
    const releaseOrigin = { hash: "#release", pathname: `/w/${workspaceId}/overview`, search: "?team=payments" }
    const releaseState = makeReleaseRouteState(workspaceId, releaseId, releaseOrigin)
    const entityOrigin = entityOriginFromLocation({
      hash: "#release-work",
      pathname: `/w/${workspaceId}/releases/${releaseId}/preview`,
      search: `?object=${entityId}`,
      state: releaseState
    })
    const firstState = makeWorkspaceEntityRouteState(releaseState, workspaceId, entityId, entityOrigin)
    const relatedState = makeWorkspaceEntityRouteState(
      firstState,
      workspaceId,
      relatedEntityId,
      entityOriginFromLocation({
        hash: "#relationships",
        pathname: workspaceEntityPath(workspaceId, entityId),
        search: ""
      })
    )

    const resolvedRelatedOrigin = resolveWorkspaceEntityOrigin(relatedState, workspaceId, relatedEntityId)
    expect(readReleaseOrigin(resolvedRelatedOrigin.origin.state, workspaceId, releaseId)).toEqual(releaseOrigin)
    expect(resolvedRelatedOrigin).toEqual({
      isStored: true,
      origin: entityOrigin
    })
    expect(Object.keys(relatedState)).toEqual(["entityOrigin"])

    const entityLocation = {
      hash: "#relationships",
      pathname: workspaceEntityPath(workspaceId, entityId),
      search: "",
      state: firstState
    }
    expect(workspaceEntityStateForHref(workspaceEntityPath(workspaceId, relatedEntityId), entityLocation)).toEqual(
      relatedState
    )
    expect(workspaceEntityStateForHref(`/w/${workspaceId}/releases/${releaseId}`, entityLocation)).toBeUndefined()
    expect(workspaceEntityStateForHref("https://jira.example.test/browse/OPS-428", entityLocation)).toBeUndefined()
  })

  it("routes release-origin entities to the release-owned agent thread", () => {
    const releaseOrigin = entityOriginFromLocation({
      hash: "#release-work",
      pathname: `/w/${workspaceId}/releases/${releaseId}/preview`,
      search: `?object=${entityId}`
    })
    const itemsOrigin = entityOriginFromLocation({
      hash: "#results",
      pathname: `/w/${workspaceId}/items`,
      search: "?q=payments"
    })
    const routableReleaseIds = new Set([releaseId])
    const noRoutableReleases = new Set<typeof releaseId>()

    expect(workspaceEntityOriginAgentPath(releaseOrigin, workspaceId, routableReleaseIds)).toBe(
      `/w/${workspaceId}/releases/${releaseId}/agent`
    )
    expect(workspaceEntityOriginAgentPath(releaseOrigin, workspaceId, noRoutableReleases)).toBeNull()
    expect(workspaceEntityOriginAgentPath(itemsOrigin, workspaceId, routableReleaseIds)).toBeNull()
    expect(workspaceEntityAgentPath(
      releaseOrigin,
      workspaceId,
      {
        hash: "#relationships",
        pathname: workspaceEntityPath(workspaceId, entityId),
        search: "?tab=review"
      },
      releaseContext([releaseId]),
      routableReleaseIds
    )).toBe(`/w/${workspaceId}/releases/${releaseId}/agent`)
    expect(workspaceEntityAgentPath(
      releaseOrigin,
      workspaceId,
      {
        hash: "#relationships",
        pathname: workspaceEntityPath(workspaceId, entityId),
        search: "?tab=review"
      },
      releaseContext([]),
      noRoutableReleases
    )).toBe(
      `/agent?from=${
        encodeURIComponent(
          `${workspaceEntityParentPath(workspaceId)}?object=${encodeURIComponent(entityId)}#item-details`
        )
      }`
    )
    expect(workspaceEntityAgentPath(
      itemsOrigin,
      workspaceId,
      {
        hash: "#relationships",
        pathname: workspaceEntityPath(workspaceId, entityId),
        search: "?tab=review"
      },
      releaseContext([releaseId]),
      routableReleaseIds
    )).toBe(`/w/${workspaceId}/releases/${releaseId}/agent`)
    expect(workspaceEntityAgentPath(
      itemsOrigin,
      workspaceId,
      {
        hash: "#relationships",
        pathname: workspaceEntityPath(workspaceId, entityId),
        search: "?tab=review"
      },
      releaseContext([releaseId]),
      noRoutableReleases
    )).toBe(
      `/agent?from=${
        encodeURIComponent(
          `${workspaceEntityParentPath(workspaceId)}?q=payments&object=${encodeURIComponent(entityId)}#item-details`
        )
      }`
    )
  })

  it("preserves Items context instead of choosing an ambiguous release thread", () => {
    const current = {
      hash: "#relationships",
      pathname: workspaceEntityPath(workspaceId, entityId),
      search: "?tab=review"
    }
    const expected = `/agent?from=${
      encodeURIComponent(
        `${workspaceEntityParentPath(workspaceId)}?object=${encodeURIComponent(entityId)}#item-details`
      )
    }`
    const filteredExpected = `/agent?from=${
      encodeURIComponent(
        `${workspaceEntityParentPath(workspaceId)}?q=payments&service=codecommit&object=${
          encodeURIComponent(
            entityId
          )
        }#item-details`
      )
    }`
    const staleReleaseOrigin = entityOriginFromLocation({
      hash: "#release-work",
      pathname: `/w/${workspaceId}/releases/${releaseId}/preview`,
      search: `?object=${entityId}`
    })
    const itemsOrigin = entityOriginFromLocation({
      hash: "#results",
      pathname: `/w/${workspaceId}/items`,
      search: "?q=payments&service=codecommit"
    })

    expect(
      workspaceEntityAgentPath(
        staleReleaseOrigin,
        workspaceId,
        current,
        releaseContext([otherReleaseId]),
        new Set([releaseId, otherReleaseId])
      )
    ).toBe(expected)
    expect(
      workspaceEntityAgentPath(
        itemsOrigin,
        workspaceId,
        current,
        releaseContext([releaseId, otherReleaseId], releaseId),
        new Set([releaseId, otherReleaseId])
      )
    ).toBe(filteredExpected)
  })

  it("falls back to Items for malformed, cross-workspace, cross-target, or unsupported origins", () => {
    const fallback = { hash: "", pathname: workspaceEntityParentPath(workspaceId), search: "", state: null }
    const validOrigin = { hash: "", pathname: `/w/${workspaceId}/timeline`, search: "", state: null }
    const valid = makeWorkspaceEntityRouteState(null, workspaceId, entityId, validOrigin)
    const unsafeOrigins = [
      { ...validOrigin, pathname: `/w/${otherWorkspaceId}/timeline` },
      { ...validOrigin, pathname: "/api/v1/items" },
      { ...validOrigin, pathname: "/pair" },
      { ...validOrigin, pathname: workspaceEntityPath(workspaceId, relatedEntityId) },
      { ...validOrigin, search: `?${"x".repeat(2_048)}` },
      { ...validOrigin, hash: `#${"x".repeat(1_024)}` }
    ]

    const unsafeNestedState = entityOriginFromLocation({
      hash: "#release-work",
      pathname: `/w/${workspaceId}/releases/${releaseId}/preview`,
      search: `?object=${entityId}`,
      state: makeReleaseRouteState(workspaceId, releaseId, {
        hash: "",
        pathname: "https://attacker.example.test/steal",
        search: ""
      })
    })

    expect(resolveWorkspaceEntityOrigin(null, workspaceId, entityId)).toEqual({ isStored: false, origin: fallback })
    expect(resolveWorkspaceEntityOrigin(valid, workspaceId, relatedEntityId)).toEqual({
      isStored: false,
      origin: fallback
    })
    expect(unsafeNestedState.state).toBeNull()
    for (const origin of unsafeOrigins) {
      expect(isSafeWorkspaceEntityOrigin(origin, workspaceId)).toBe(false)
      const state = makeWorkspaceEntityRouteState([], workspaceId, entityId, origin)
      expect(resolveWorkspaceEntityOrigin(state, workspaceId, entityId)).toEqual({
        isStored: true,
        origin: fallback
      })
    }
  })
})
