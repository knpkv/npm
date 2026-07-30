import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import { describe, expect, it } from "vitest"

import {
  CONTROL_CENTER_LAYOUT_ONLY_ROUTE_LITERALS,
  CONTROL_CENTER_PRODUCTION_ROUTE_DESCRIPTORS,
  CONTROL_CENTER_PRODUCTION_ROUTE_FAMILIES,
  CONTROL_CENTER_PRODUCTION_ROUTE_LITERALS,
  productionRouteAuditCase,
  requiredProductionRouteAuditsFor
} from "../../e2e/productionRouteInventory.js"

describe("Control Center production route presentation inventory", () => {
  it("fails when a declared router path has no browser presentation owner", async () => {
    const routerSource = await Effect.runPromise(
      Effect.gen(function*() {
        const fileSystem = yield* FileSystem.FileSystem
        const routerUrl = new URL("../../src/client/router.tsx", import.meta.url)
        return yield* fileSystem.readFileString(routerUrl.pathname)
      }).pipe(Effect.provide(NodeServices.layer))
    )
    const declaredLiterals = Array.from(routerSource.matchAll(/\bpath: "([^"]+)"/gu), ([, path]) => path).sort()
    const declaredIndexRouteCount = Array.from(routerSource.matchAll(/\bindex: true\b/gu)).length

    expect(declaredLiterals).toEqual(CONTROL_CENTER_PRODUCTION_ROUTE_LITERALS)
    expect(CONTROL_CENTER_PRODUCTION_ROUTE_DESCRIPTORS.filter(({ ownsIndexRoute }) => ownsIndexRoute).length).toBe(
      declaredIndexRouteCount
    )
    expect(CONTROL_CENTER_PRODUCTION_ROUTE_DESCRIPTORS.find(({ ownsIndexRoute }) => ownsIndexRoute)?.family).toBe(
      "overview"
    )
  })

  it("keeps every acceptance surface assigned to a distinct typed route family", () => {
    expect(new Set(CONTROL_CENTER_PRODUCTION_ROUTE_FAMILIES).size).toBe(CONTROL_CENTER_PRODUCTION_ROUTE_FAMILIES.length)
    expect(CONTROL_CENTER_PRODUCTION_ROUTE_DESCRIPTORS.every(({ audits }) => audits.length > 0)).toBe(true)
    expect(CONTROL_CENTER_PRODUCTION_ROUTE_FAMILIES).toEqual([
      "agent",
      "authorized-share",
      "atlassian-oauth-callback",
      "item",
      "items",
      "not-found",
      "overview",
      "pair",
      "release",
      "release-preview",
      "services",
      "settings",
      "timeline",
      "work"
    ])
    expect(CONTROL_CENTER_LAYOUT_ONLY_ROUTE_LITERALS).toEqual(["w/:workspaceId"])
    expect(
      CONTROL_CENTER_PRODUCTION_ROUTE_DESCRIPTORS.flatMap(({ audits, family, routerLiterals }) =>
        audits.map(({ canonicalPath, owner, presentation }) => ({
          canonicalPath,
          family,
          owner,
          presentation,
          routerLiterals
        }))
      )
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          family: "services",
          owner: "scaffold",
          presentation: "unauthenticated",
          routerLiterals: ["services"]
        }),
        expect.objectContaining({
          family: "services",
          owner: "release-routes",
          presentation: "authenticated",
          routerLiterals: ["services"]
        })
      ])
    )
  })

  it("requires every declared browser owner to consume its exact family and presentation assignments", () => {
    const assignedKeys = ["scaffold", "release-routes", "workspace-settings"].flatMap((owner) =>
      requiredProductionRouteAuditsFor(
        owner === "scaffold" || owner === "release-routes" ? owner : "workspace-settings"
      ).map(({ family, presentation }) => `${family}:${presentation}`)
    )

    expect(new Set(assignedKeys).size).toBe(assignedKeys.length)
    expect(() => productionRouteAuditCase("scaffold", "settings", "authenticated")).toThrow(
      "settings:authenticated is not owned by scaffold"
    )
    expect(productionRouteAuditCase("release-routes", "item", "authenticated").canonicalPath).toContain(
      "/items/01890f6f"
    )
  })
})
