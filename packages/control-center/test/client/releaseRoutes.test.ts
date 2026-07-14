import { describe, expect, it } from "vitest"

import {
  decodeReleaseRouteId,
  decodeWorkspaceRouteId,
  makeReleaseRouteState,
  readReleaseOrigin,
  releaseFullPath,
  releaseOriginFromLocation,
  releaseOriginHref,
  releaseParentPath,
  releasePreviewPath,
  releaseTransitionNames
} from "../../src/client/releases/releaseRoutes.js"
import { makePortfolioSnapshot } from "./portfolioFixtures.js"

const snapshot = makePortfolioSnapshot()
const workspaceId = snapshot.workspaceId
const releaseId = snapshot.releases[0]?.releaseId
if (releaseId === undefined) throw new Error("Expected a release route fixture")

describe("release routes", () => {
  it("builds one canonical parent, preview, and full path from decoded identities", () => {
    expect(releaseParentPath(workspaceId)).toBe(`/w/${workspaceId}/overview`)
    expect(releasePreviewPath(workspaceId, releaseId)).toBe(`/w/${workspaceId}/releases/${releaseId}/preview`)
    expect(releaseFullPath(workspaceId, releaseId)).toBe(`/w/${workspaceId}/releases/${releaseId}`)
    expect(releaseTransitionNames(releaseId)).toEqual({
      relay: `release-${releaseId}-relay`,
      verdict: `release-${releaseId}-verdict`,
      version: `release-${releaseId}-version`
    })
    expect(decodeWorkspaceRouteId(workspaceId)).toBe(workspaceId)
    expect(decodeReleaseRouteId(releaseId)).toBe(releaseId)
    expect(decodeWorkspaceRouteId("not-a-workspace")).toBeNull()
    expect(decodeReleaseRouteId("not-a-release")).toBeNull()
  })

  it("round-trips the exact bounded overview origin through versioned state", () => {
    const origin = releaseOriginFromLocation({
      hash: "#candidate",
      pathname: releaseParentPath(workspaceId),
      search: "?filter=attention"
    })
    const state = makeReleaseRouteState(workspaceId, releaseId, origin)
    expect(readReleaseOrigin(state, workspaceId, releaseId)).toEqual(origin)
    expect(releaseOriginHref(origin)).toBe(`${releaseParentPath(workspaceId)}?filter=attention#candidate`)
    expect(JSON.stringify(state)).not.toMatch(/csrf|session|snapshot|token/iu)
  })

  it("falls back to the semantic parent for malformed, cross-target, or non-UI origins", () => {
    const fallback = { hash: "", pathname: releaseParentPath(workspaceId), search: "" }
    const otherWorkspaceId = decodeWorkspaceRouteId("01890f6f-6d6a-7cc0-98d2-000000000099")
    const otherReleaseId = decodeReleaseRouteId("01890f6f-6d6a-7cc0-98d2-000000000098")
    if (otherWorkspaceId === null || otherReleaseId === null) throw new Error("Expected alternate route identities")
    const origin = { hash: "", pathname: releaseParentPath(workspaceId), search: "" }
    const valid = makeReleaseRouteState(workspaceId, releaseId, origin)

    expect(readReleaseOrigin(null, workspaceId, releaseId)).toEqual(fallback)
    expect(readReleaseOrigin({ ...valid, _tag: "release-origin/v0" }, workspaceId, releaseId)).toEqual(fallback)
    expect(readReleaseOrigin({ ...valid, releaseId: otherReleaseId }, workspaceId, releaseId)).toEqual(fallback)
    expect(readReleaseOrigin({ ...valid, workspaceId: otherWorkspaceId }, workspaceId, releaseId)).toEqual(fallback)
    expect(
      readReleaseOrigin(
        { ...valid, origin: { ...origin, pathname: "/api/v1/portfolio/snapshot" } },
        workspaceId,
        releaseId
      )
    ).toEqual(fallback)
    expect(readReleaseOrigin({ ...valid, origin: { ...origin, pathname: "/pair" } }, workspaceId, releaseId)).toEqual(
      fallback
    )
    expect(
      readReleaseOrigin({ ...valid, origin: { ...origin, search: `?${"x".repeat(2_048)}` } }, workspaceId, releaseId)
    ).toEqual(fallback)
  })
})
