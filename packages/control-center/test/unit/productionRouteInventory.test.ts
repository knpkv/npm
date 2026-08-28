import * as NodeServices from "@effect/platform-node/NodeServices"
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import * as ts from "typescript"

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

interface DeclaredRouterInventory {
  readonly indexRouteCount: number
  readonly paths: ReadonlyArray<string>
}

const declaredRouterInventory = (source: string, fileName = "router.tsx"): DeclaredRouterInventory => {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  let routerRoutes: ts.ArrayLiteralExpression | undefined
  const findRouter = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "createBrowserRouter"
    ) {
      const routes = node.arguments[0]
      if (routes === undefined || !ts.isArrayLiteralExpression(routes)) {
        throw new Error("createBrowserRouter routes must be an inline array for presentation inventory")
      }
      if (routerRoutes !== undefined) throw new Error("expected exactly one createBrowserRouter declaration")
      routerRoutes = routes
    }
    ts.forEachChild(node, findRouter)
  }
  findRouter(sourceFile)
  if (routerRoutes === undefined) throw new Error("createBrowserRouter declaration was not found")

  const paths: Array<string> = []
  let indexRouteCount = 0
  const propertyName = (property: ts.ObjectLiteralElementLike): string | undefined => {
    if (!("name" in property) || property.name === undefined) return undefined
    if (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) return property.name.text
    if (
      ts.isComputedPropertyName(property.name) &&
      (ts.isStringLiteral(property.name.expression) || ts.isNoSubstitutionTemplateLiteral(property.name.expression))
    ) {
      return property.name.expression.text
    }
    if (ts.isComputedPropertyName(property.name)) {
      throw new Error(`computed router property cannot be inventoried: ${property.name.getText(sourceFile)}`)
    }
    return undefined
  }
  const visitRoutes = (routes: ts.ArrayLiteralExpression): void => {
    for (const route of routes.elements) {
      if (!ts.isObjectLiteralExpression(route)) {
        throw new Error(`router route must be an inline object: ${route.getText(sourceFile)}`)
      }
      for (const property of route.properties) {
        if (ts.isSpreadAssignment(property)) {
          throw new Error(`router route spreads cannot be inventoried: ${property.getText(sourceFile)}`)
        }
        const name = propertyName(property)
        if (name === "path") {
          if (!ts.isPropertyAssignment(property)) {
            throw new Error(`router path must be a property assignment: ${property.getText(sourceFile)}`)
          }
          if (!ts.isStringLiteral(property.initializer) && !ts.isNoSubstitutionTemplateLiteral(property.initializer)) {
            throw new Error(`router path must be a static literal: ${property.initializer.getText(sourceFile)}`)
          }
          paths.push(property.initializer.text)
        }
        if (
          name === "index" &&
          ts.isPropertyAssignment(property) &&
          property.initializer.kind === ts.SyntaxKind.TrueKeyword
        ) {
          indexRouteCount += 1
        }
        if (
          name === "index" &&
          (
            !ts.isPropertyAssignment(property) ||
            property.initializer.kind !== ts.SyntaxKind.TrueKeyword &&
              property.initializer.kind !== ts.SyntaxKind.FalseKeyword
          )
        ) {
          throw new Error(`router index must be a static boolean: ${property.getText(sourceFile)}`)
        }
        if (name === "children") {
          if (!ts.isPropertyAssignment(property) || !ts.isArrayLiteralExpression(property.initializer)) {
            throw new Error(`router children must be an inline array: ${property.getText(sourceFile)}`)
          }
          visitRoutes(property.initializer)
        }
      }
    }
  }
  visitRoutes(routerRoutes)
  return { indexRouteCount, paths: paths.sort() }
}

describe("Control Center production route presentation inventory", () => {
  it.effect("fails when a declared router path has no browser presentation owner", () =>
    Effect.gen(function*() {
      const routerSource = yield* Effect.gen(function*() {
        const fileSystem = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const routerPath = yield* path.fromFileUrl(new URL("../../src/client/router.tsx", import.meta.url))
        return yield* fileSystem.readFileString(routerPath)
      }).pipe(
        // The test owns this isolated Node service boundary.
        // @effect-diagnostics-next-line strictEffectProvide:off
        Effect.provide(NodeServices.layer)
      )

      const declared = declaredRouterInventory(routerSource)

      expect(declared.paths).toEqual(CONTROL_CENTER_PRODUCTION_ROUTE_LITERALS)
      expect(CONTROL_CENTER_PRODUCTION_ROUTE_DESCRIPTORS.filter(({ ownsIndexRoute }) => ownsIndexRoute).length).toBe(
        declared.indexRouteCount
      )
      expect(CONTROL_CENTER_PRODUCTION_ROUTE_DESCRIPTORS.find(({ ownsIndexRoute }) => ownsIndexRoute)?.family).toBe(
        "overview"
      )
    }))

  it("fails closed on nonliteral router paths while accepting inventoried parameter literals", () => {
    expect(() =>
      declaredRouterInventory(
        `const REPORTS_PATH = "reports"; createBrowserRouter([{ path: REPORTS_PATH, lazy: reportsRoute }])`
      )
    ).toThrow("router path must be a static literal: REPORTS_PATH")
    expect(
      declaredRouterInventory(`createBrowserRouter([{ path: "reports/:reportId", lazy: reportsRoute }])`)
    ).toEqual({
      indexRouteCount: 0,
      paths: ["reports/:reportId"]
    })
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
      "open-pr",
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
    expect(() => productionRouteAuditCase("scaffold", "settings", "authenticated", "settings")).toThrow(
      "settings:settings:authenticated is not owned by scaffold"
    )
    expect(productionRouteAuditCase("release-routes", "item", "authenticated", "items/:entityId").canonicalPath)
      .toContain(
        "/items/01890f6f"
      )
    expect(
      productionRouteAuditKey(productionRouteAuditCase("scaffold", "agent", "authenticated", "agent"))
    ).not.toBe(
      productionRouteAuditKey(
        productionRouteAuditCase("release-routes", "agent", "authenticated", "releases/:releaseId/agent")
      )
    )
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

    const itemsDescriptor = CONTROL_CENTER_PRODUCTION_ROUTE_DESCRIPTORS.find(({ family }) => family === "items")
    if (itemsDescriptor === undefined) throw new Error("expected the items route descriptor")
    const authenticatedItemsAudit = itemsDescriptor.audits.find(
      ({ presentation }) => presentation === "authenticated"
    )
    if (authenticatedItemsAudit === undefined) throw new Error("expected the authenticated items audit")
    expect(
      productionRouteCoverageFailures(
        [
          {
            ...itemsDescriptor,
            audits: [authenticatedItemsAudit]
          }
        ],
        [{ family: "items", routerLiteral: "items" }],
        []
      )
    ).toEqual(["items (items) is missing its unauthenticated presentation"])

    const itemDescriptor = CONTROL_CENTER_PRODUCTION_ROUTE_DESCRIPTORS.find(({ family }) => family === "item")
    if (itemDescriptor === undefined) throw new Error("expected the item route descriptor")
    const authenticatedItemAudit = itemDescriptor.audits.find(
      ({ presentation }) => presentation === "authenticated"
    )
    if (authenticatedItemAudit === undefined) throw new Error("expected the authenticated item audit")
    expect(
      productionRouteCoverageFailures(
        [
          {
            ...itemDescriptor,
            audits: [authenticatedItemAudit]
          }
        ],
        [{ family: "item", routerLiteral: "items/:entityId" }],
        []
      )
    ).toEqual(["item (items/:entityId) is missing its unauthenticated presentation"])

    const callbackDescriptor = CONTROL_CENTER_PRODUCTION_ROUTE_DESCRIPTORS.find(
      ({ family }) => family === "atlassian-oauth-callback"
    )
    if (callbackDescriptor === undefined) throw new Error("expected the Atlassian callback route descriptor")
    const authenticatedCallbackBoundary = callbackDescriptor.audits.find(
      ({ presentation }) => presentation === "authenticated-error"
    )
    if (authenticatedCallbackBoundary === undefined) throw new Error("expected the authenticated callback boundary")
    expect(
      productionRouteCoverageFailures(
        [{ ...callbackDescriptor, audits: [authenticatedCallbackBoundary] }],
        [],
        ["atlassian-oauth-callback"]
      )
    ).toEqual(["atlassian-oauth-callback is missing its primary ready surface"])
    expect(
      callbackDescriptor.audits.find(({ presentation }) => presentation === "authenticated")
    ).toEqual(
      expect.objectContaining({
        canonicalPath: expect.stringContaining(`state=${"a".repeat(43)}`),
        surface: "primary"
      })
    )

    const timelineDescriptor = CONTROL_CENTER_PRODUCTION_ROUTE_DESCRIPTORS.find(
      ({ family }) => family === "timeline"
    )
    if (timelineDescriptor === undefined) throw new Error("expected the Timeline route descriptor")
    const authenticatedTimelineAudit = timelineDescriptor.audits.find(
      ({ presentation }) => presentation === "authenticated"
    )
    if (authenticatedTimelineAudit === undefined) throw new Error("expected the authenticated Timeline audit")
    expect(
      productionRouteCoverageFailures(
        [{ ...timelineDescriptor, audits: [authenticatedTimelineAudit] }],
        [{ family: "timeline", routerLiteral: "timeline" }],
        []
      )
    ).toEqual(["timeline (timeline) is missing its unauthenticated presentation"])

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
        [{ ...agentDescriptor, audits: [releaseAgentAudit] }],
        [{ family: "agent", routerLiteral: "releases/:releaseId/agent" }],
        []
      )
    ).toEqual(["agent (releases/:releaseId/agent) is missing its unauthenticated presentation"])

    expect(
      productionRouteCoverageFailures(
        CONTROL_CENTER_PRODUCTION_ROUTE_DESCRIPTORS,
        [{ family: "services", routerLiteral: "services" }],
        ["services"]
      )
    ).toEqual([])
  })

  it("requires every router leaf literal to own an audit or a documented exemption", () => {
    const unownedLeaves = CONTROL_CENTER_PRODUCTION_ROUTE_DESCRIPTORS.flatMap((descriptor) =>
      Array.from(new Set(descriptor.routerLiterals)).flatMap((routerLiteral) => {
        const audited = descriptor.audits.some((audit) => audit.routerLiteral === routerLiteral)
        const exemption = CONTROL_CENTER_PRODUCTION_ROUTE_LEAF_EXEMPTIONS.find(
          (candidate) => candidate.family === descriptor.family && candidate.routerLiteral === routerLiteral
        )
        return audited || (exemption !== undefined && exemption.reason.trim().length > 0)
          ? []
          : [`${descriptor.family}:${routerLiteral}`]
      })
    )
    expect(unownedLeaves).toEqual([])
  })
})
