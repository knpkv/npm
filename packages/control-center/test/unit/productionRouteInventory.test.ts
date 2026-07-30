import * as NodeServices from "@effect/platform-node/NodeServices"
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"

import {
  CONTROL_CENTER_LAYOUT_ONLY_ROUTE_LITERALS,
  CONTROL_CENTER_PRODUCTION_ROUTE_DESCRIPTORS,
  CONTROL_CENTER_PRODUCTION_ROUTE_FAMILIES,
  CONTROL_CENTER_PRODUCTION_ROUTE_LEAF_EXEMPTIONS,
  CONTROL_CENTER_PRODUCTION_ROUTE_LITERALS,
  CONTROL_CENTER_READY_ROUTE_FAMILIES,
  CONTROL_CENTER_SESSION_SENSITIVE_ROUTE_LEAVES,
  productionRouteAuditCase,
  productionRouteAuditKey,
  productionRouteCoverageFailures,
  requiredProductionRouteAuditsFor
} from "../../e2e/productionRouteInventory.js"

describe("Control Center production route presentation inventory", () => {
  it.effect("fails when a declared router path has no browser presentation owner", () =>
    Effect.gen(function*() {
      const routerSource = yield* Effect.gen(function*() {
        const fileSystem = yield* FileSystem.FileSystem
        const routerUrl = new URL("../../src/client/router.tsx", import.meta.url)
        return yield* fileSystem.readFileString(routerUrl.pathname)
      }).pipe(Effect.provide(NodeServices.layer))

      const declaredLiterals = Array.from(routerSource.matchAll(/\bpath: "([^"]+)"/gu), ([, path]) => path).sort()
      const declaredIndexRouteCount = Array.from(routerSource.matchAll(/\bindex: true\b/gu)).length

      expect(declaredLiterals).toEqual(CONTROL_CENTER_PRODUCTION_ROUTE_LITERALS)
      expect(CONTROL_CENTER_PRODUCTION_ROUTE_DESCRIPTORS.filter(({ ownsIndexRoute }) => ownsIndexRoute).length).toBe(
        declaredIndexRouteCount
      )
      expect(CONTROL_CENTER_PRODUCTION_ROUTE_DESCRIPTORS.find(({ ownsIndexRoute }) => ownsIndexRoute)?.family).toBe(
        "overview"
      )
    }))

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
        audits.map(({ canonicalPath, owner, presentation, routerLiteral }) => ({
          canonicalPath,
          family,
          owner,
          presentation,
          routerLiteral,
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
      ).map(productionRouteAuditKey)
    )

    expect(new Set(assignedKeys).size).toBe(assignedKeys.length)
    expect(() => productionRouteAuditCase("scaffold", "settings", "authenticated")).toThrow(
      "settings:authenticated is not owned by scaffold"
    )
    expect(productionRouteAuditCase("release-routes", "item", "authenticated").canonicalPath).toContain(
      "/items/01890f6f"
    )
    expect(
      productionRouteAuditKey(productionRouteAuditCase("scaffold", "agent", "authenticated"))
    ).not.toBe(productionRouteAuditKey(productionRouteAuditCase("release-routes", "agent", "authenticated")))
  })

  it("requires both session variants on each declared leaf and a primary audit for every ready route family", () => {
    expect(
      productionRouteCoverageFailures(
        CONTROL_CENTER_PRODUCTION_ROUTE_DESCRIPTORS,
        CONTROL_CENTER_SESSION_SENSITIVE_ROUTE_LEAVES,
        CONTROL_CENTER_READY_ROUTE_FAMILIES
      )
    ).toEqual([])

    expect(
      productionRouteCoverageFailures(
        [
          {
            audits: [
              {
                action: { kind: "required" },
                canonicalPath: "/w/workspace/settings",
                owner: "workspace-settings",
                presentation: "authenticated",
                routerLiteral: "settings",
                surface: "primary"
              }
            ],
            family: "settings",
            routerLiterals: ["settings"]
          }
        ],
        [{ family: "settings", routerLiteral: "settings" }],
        []
      )
    ).toEqual(["settings (settings) is missing its unauthenticated presentation"])

    const agentDescriptor = CONTROL_CENTER_PRODUCTION_ROUTE_DESCRIPTORS.find(({ family }) => family === "agent")
    if (agentDescriptor === undefined) throw new Error("expected the agent route descriptor")
    const anonymousAgentAudit = agentDescriptor.audits.find(
      ({ presentation, routerLiteral }) => presentation === "unauthenticated" && routerLiteral === "agent"
    )
    const releaseAgentAudit = agentDescriptor.audits.find(
      ({ presentation, routerLiteral }) =>
        presentation === "authenticated" && routerLiteral === "releases/:releaseId/agent"
    )
    if (anonymousAgentAudit === undefined || releaseAgentAudit === undefined) {
      throw new Error("expected both existing agent leaf fixtures")
    }
    expect(
      productionRouteCoverageFailures(
        [
          {
            ...agentDescriptor,
            audits: [anonymousAgentAudit, releaseAgentAudit]
          }
        ],
        [{ family: "agent", routerLiteral: "agent" }],
        []
      )
    ).toEqual(["agent (agent) is missing its authenticated presentation"])

    expect(
      productionRouteCoverageFailures(
        CONTROL_CENTER_PRODUCTION_ROUTE_DESCRIPTORS,
        [{ family: "services", routerLiteral: "services" }],
        ["services"]
      )
    ).toEqual([])
  })

  it("requires every router leaf literal to own an audit or a documented exemption", () => {
    for (const descriptor of CONTROL_CENTER_PRODUCTION_ROUTE_DESCRIPTORS) {
      for (const routerLiteral of new Set(descriptor.routerLiterals)) {
        const audited = descriptor.audits.some((audit) => audit.routerLiteral === routerLiteral)
        const exemption = CONTROL_CENTER_PRODUCTION_ROUTE_LEAF_EXEMPTIONS.find(
          (candidate) => candidate.family === descriptor.family && candidate.routerLiteral === routerLiteral
        )
        expect(audited || (exemption !== undefined && exemption.reason.trim().length > 0)).toBe(true)
      }
    }
  })
})
