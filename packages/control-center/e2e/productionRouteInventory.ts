export type ProductionRouteFamily =
  | "agent"
  | "authorized-share"
  | "atlassian-oauth-callback"
  | "item"
  | "items"
  | "not-found"
  | "overview"
  | "pair"
  | "release"
  | "release-preview"
  | "services"
  | "settings"
  | "timeline"
  | "work"

export type ProductionRoutePresentation = "authenticated" | "unauthenticated"
export type ProductionRouteAuditOwner = "release-routes" | "scaffold" | "workspace-settings"

export interface ProductionRouteAuditRequirement {
  readonly action:
    | { readonly kind: "required" }
    | { readonly kind: "none"; readonly reason: string }
  readonly canonicalPath: string
  readonly family: ProductionRouteFamily
  readonly owner: ProductionRouteAuditOwner
  readonly presentation: ProductionRoutePresentation
}

interface ProductionRouteFamilyDescriptor {
  readonly audits: readonly [
    Omit<ProductionRouteAuditRequirement, "family">,
    ...ReadonlyArray<Omit<ProductionRouteAuditRequirement, "family">>
  ]
  readonly family: ProductionRouteFamily
  readonly ownsIndexRoute?: boolean
  readonly routerLiterals: ReadonlyArray<string>
}

const WORKSPACE_ID = "01890f6f-6d6a-7cc0-98d2-000000000001"
const RELEASE_ID = "01890f6f-6d6a-7cc0-98d2-000000000011"
const ENTITY_ID = "01890f6f-6d6a-7cc0-98d3-000000000001"
const SHARE_ID = "01890f6f-6d6a-7cc0-98d2-000000000090"

/** Router parents that own layout/context only and deliberately have no leaf presentation. */
export const CONTROL_CENTER_LAYOUT_ONLY_ROUTE_LITERALS: ReadonlyArray<string> = ["w/:workspaceId"]

/** Typed ownership for every production route family and session-dependent presentation. */
export const CONTROL_CENTER_PRODUCTION_ROUTE_DESCRIPTORS: ReadonlyArray<ProductionRouteFamilyDescriptor> = [
  {
    audits: [
      { action: { kind: "required" }, canonicalPath: "/agent", owner: "scaffold", presentation: "unauthenticated" },
      {
        action: { kind: "required" },
        canonicalPath: `/w/${WORKSPACE_ID}/releases/${RELEASE_ID}/agent`,
        owner: "release-routes",
        presentation: "authenticated"
      }
    ],
    family: "agent",
    routerLiterals: ["agent", "releases/:releaseId/agent"]
  },
  {
    audits: [
      {
        action: { kind: "required" },
        canonicalPath: `/shares/${WORKSPACE_ID}/${SHARE_ID}`,
        owner: "scaffold",
        presentation: "unauthenticated"
      },
      {
        action: {
          kind: "none",
          reason: "A resolved exact-scope share is intentionally read-only and exposes no route-owned action."
        },
        canonicalPath: `/shares/${WORKSPACE_ID}/${SHARE_ID}`,
        owner: "release-routes",
        presentation: "authenticated"
      }
    ],
    family: "authorized-share",
    routerLiterals: ["shares/:workspaceId/:shareId"]
  },
  {
    audits: [
      {
        action: { kind: "required" },
        canonicalPath: "/services/oauth/atlassian/callback?code=fixture&state=fixture",
        owner: "scaffold",
        presentation: "unauthenticated"
      },
      {
        action: { kind: "required" },
        canonicalPath: "/services/oauth/atlassian/callback?code=fixture&state=fixture",
        owner: "release-routes",
        presentation: "authenticated"
      }
    ],
    family: "atlassian-oauth-callback",
    routerLiterals: ["services/oauth/atlassian/callback"]
  },
  {
    audits: [
      {
        action: { kind: "required" },
        canonicalPath: `/w/${WORKSPACE_ID}/items/${ENTITY_ID}`,
        owner: "release-routes",
        presentation: "authenticated"
      }
    ],
    family: "item",
    routerLiterals: ["items/:entityId"]
  },
  {
    audits: [
      {
        action: { kind: "required" },
        canonicalPath: `/w/${WORKSPACE_ID}/items`,
        owner: "release-routes",
        presentation: "authenticated"
      }
    ],
    family: "items",
    routerLiterals: ["items"]
  },
  {
    audits: [
      {
        action: { kind: "required" },
        canonicalPath: "/not-a-production-route",
        owner: "scaffold",
        presentation: "unauthenticated"
      },
      {
        action: { kind: "required" },
        canonicalPath: `/w/${WORKSPACE_ID}/not-a-production-route`,
        owner: "release-routes",
        presentation: "authenticated"
      }
    ],
    family: "not-found",
    routerLiterals: ["*", "*"]
  },
  {
    audits: [
      { action: { kind: "required" }, canonicalPath: "/", owner: "scaffold", presentation: "unauthenticated" },
      {
        action: { kind: "required" },
        canonicalPath: `/w/${WORKSPACE_ID}/overview`,
        owner: "release-routes",
        presentation: "authenticated"
      }
    ],
    family: "overview",
    ownsIndexRoute: true,
    routerLiterals: ["overview", "releases"]
  },
  {
    audits: [
      { action: { kind: "required" }, canonicalPath: "/pair", owner: "scaffold", presentation: "unauthenticated" }
    ],
    family: "pair",
    routerLiterals: ["pair"]
  },
  {
    audits: [
      {
        action: { kind: "required" },
        canonicalPath: `/w/${WORKSPACE_ID}/releases/${RELEASE_ID}`,
        owner: "release-routes",
        presentation: "authenticated"
      }
    ],
    family: "release",
    routerLiterals: ["releases/:releaseId"]
  },
  {
    audits: [
      {
        action: { kind: "required" },
        canonicalPath: `/w/${WORKSPACE_ID}/releases/${RELEASE_ID}/preview`,
        owner: "release-routes",
        presentation: "authenticated"
      }
    ],
    family: "release-preview",
    routerLiterals: ["releases/:releaseId/preview"]
  },
  {
    audits: [
      { action: { kind: "required" }, canonicalPath: "/services", owner: "scaffold", presentation: "unauthenticated" },
      {
        action: { kind: "required" },
        canonicalPath: "/services",
        owner: "release-routes",
        presentation: "authenticated"
      }
    ],
    family: "services",
    routerLiterals: ["services"]
  },
  {
    audits: [
      {
        action: { kind: "required" },
        canonicalPath: `/w/${WORKSPACE_ID}/settings`,
        owner: "workspace-settings",
        presentation: "authenticated"
      }
    ],
    family: "settings",
    routerLiterals: ["settings"]
  },
  {
    audits: [
      {
        action: { kind: "required" },
        canonicalPath: `/w/${WORKSPACE_ID}/timeline`,
        owner: "release-routes",
        presentation: "authenticated"
      }
    ],
    family: "timeline",
    routerLiterals: ["timeline"]
  },
  {
    audits: [
      {
        action: { kind: "required" },
        canonicalPath: `/w/${WORKSPACE_ID}/work?release=${RELEASE_ID}`,
        owner: "release-routes",
        presentation: "authenticated"
      }
    ],
    family: "work",
    routerLiterals: ["work"]
  }
]

/** Stable key used by browser owners to prove every assigned presentation actually ran. */
export const productionRouteAuditKey = (
  family: ProductionRouteFamily,
  presentation: ProductionRoutePresentation
): string => `${family}:${presentation}`

/** Resolve one declared audit; browser matrices cannot invent cases outside the inventory. */
export const productionRouteAuditCase = (
  owner: ProductionRouteAuditOwner,
  family: ProductionRouteFamily,
  presentation: ProductionRoutePresentation
): ProductionRouteAuditRequirement => {
  const descriptor = CONTROL_CENTER_PRODUCTION_ROUTE_DESCRIPTORS.find((candidate) => candidate.family === family)
  const audit = descriptor?.audits.find(
    (candidate) => candidate.owner === owner && candidate.presentation === presentation
  )
  if (audit === undefined) {
    throw new Error(`Production route audit ${productionRouteAuditKey(family, presentation)} is not owned by ${owner}`)
  }
  return { ...audit, family }
}

/** Exact audits assigned to one browser suite. */
export const requiredProductionRouteAuditsFor = (
  owner: ProductionRouteAuditOwner
): ReadonlyArray<ProductionRouteAuditRequirement> =>
  CONTROL_CENTER_PRODUCTION_ROUTE_DESCRIPTORS.flatMap((descriptor) =>
    descriptor.audits
      .filter((audit) => audit.owner === owner)
      .map((audit) => ({ ...audit, family: descriptor.family }))
  )

/** Literal route declarations that must retain typed presentation ownership or a layout-only exemption. */
export const CONTROL_CENTER_PRODUCTION_ROUTE_LITERALS: ReadonlyArray<string> = Array.from(
  CONTROL_CENTER_PRODUCTION_ROUTE_DESCRIPTORS.flatMap(({ routerLiterals }) => routerLiterals).concat(
    CONTROL_CENTER_LAYOUT_ONLY_ROUTE_LITERALS
  )
).sort()

/** Route families exercised by the shared presentation audit. */
export const CONTROL_CENTER_PRODUCTION_ROUTE_FAMILIES: ReadonlyArray<ProductionRouteFamily> =
  CONTROL_CENTER_PRODUCTION_ROUTE_DESCRIPTORS.map(({ family }) => family)
