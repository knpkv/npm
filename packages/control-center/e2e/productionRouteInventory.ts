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
export type ProductionRouteSurface = "boundary" | "primary"

export interface ProductionRouteAuditRequirement {
  readonly action:
    | { readonly kind: "required" }
    | { readonly kind: "none"; readonly reason: string }
  readonly canonicalPath: string
  readonly family: ProductionRouteFamily
  readonly owner: ProductionRouteAuditOwner
  readonly presentation: ProductionRoutePresentation
  readonly routerLiteral: string
  readonly surface: ProductionRouteSurface
}

export interface ProductionRouteFamilyDescriptor {
  readonly audits: readonly [
    Omit<ProductionRouteAuditRequirement, "family">,
    ...ReadonlyArray<Omit<ProductionRouteAuditRequirement, "family">>
  ]
  readonly family: ProductionRouteFamily
  readonly ownsIndexRoute?: boolean
  readonly routerLiterals: ReadonlyArray<string>
}

export interface ProductionRouteLeaf {
  readonly family: ProductionRouteFamily
  readonly routerLiteral: string
}

export interface ProductionRouteLeafExemption extends ProductionRouteLeaf {
  readonly reason: string
}

/** Stable identities shared by canonical paths and their browser response fixtures. */
export const CONTROL_CENTER_PRODUCTION_ROUTE_FIXTURE_IDS = Object.freeze({
  entityId: "01890f6f-6d6a-7cc0-98d3-000000000001",
  releaseId: "01890f6f-6d6a-7cc0-98d2-000000000011",
  shareId: "01890f6f-6d6a-7cc0-98d2-000000000090",
  workspaceId: "01890f6f-6d6a-7cc0-98d2-000000000001"
})

const {
  entityId: ENTITY_ID,
  releaseId: RELEASE_ID,
  shareId: SHARE_ID,
  workspaceId: WORKSPACE_ID
} = CONTROL_CENTER_PRODUCTION_ROUTE_FIXTURE_IDS

/** Router parents that own layout/context only and deliberately have no leaf presentation. */
export const CONTROL_CENTER_LAYOUT_ONLY_ROUTE_LITERALS: ReadonlyArray<string> = ["w/:workspaceId"]

/** Typed ownership for every production route family and session-dependent presentation. */
export const CONTROL_CENTER_PRODUCTION_ROUTE_DESCRIPTORS: ReadonlyArray<ProductionRouteFamilyDescriptor> = [
  {
    audits: [
      {
        action: { kind: "required" },
        canonicalPath: "/agent",
        owner: "scaffold",
        presentation: "unauthenticated",
        routerLiteral: "agent",
        surface: "boundary"
      },
      {
        action: { kind: "required" },
        canonicalPath: "/agent",
        owner: "scaffold",
        presentation: "authenticated",
        routerLiteral: "agent",
        surface: "primary"
      },
      {
        action: { kind: "required" },
        canonicalPath: `/w/${WORKSPACE_ID}/releases/${RELEASE_ID}/agent`,
        owner: "release-routes",
        presentation: "authenticated",
        routerLiteral: "releases/:releaseId/agent",
        surface: "primary"
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
        presentation: "unauthenticated",
        routerLiteral: "shares/:workspaceId/:shareId",
        surface: "boundary"
      },
      {
        action: {
          kind: "none",
          reason: "A resolved exact-scope share is intentionally read-only and exposes no route-owned action."
        },
        canonicalPath: `/shares/${WORKSPACE_ID}/${SHARE_ID}`,
        owner: "release-routes",
        presentation: "authenticated",
        routerLiteral: "shares/:workspaceId/:shareId",
        surface: "primary"
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
        presentation: "unauthenticated",
        routerLiteral: "services/oauth/atlassian/callback",
        surface: "boundary"
      },
      {
        action: { kind: "required" },
        canonicalPath: "/services/oauth/atlassian/callback?code=fixture&state=fixture",
        owner: "release-routes",
        presentation: "authenticated",
        routerLiteral: "services/oauth/atlassian/callback",
        surface: "boundary"
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
        presentation: "authenticated",
        routerLiteral: "items/:entityId",
        surface: "primary"
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
        owner: "scaffold",
        presentation: "unauthenticated",
        routerLiteral: "items",
        surface: "boundary"
      },
      {
        action: { kind: "required" },
        canonicalPath: `/w/${WORKSPACE_ID}/items`,
        owner: "release-routes",
        presentation: "authenticated",
        routerLiteral: "items",
        surface: "primary"
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
        presentation: "unauthenticated",
        routerLiteral: "*",
        surface: "boundary"
      },
      {
        action: { kind: "required" },
        canonicalPath: `/w/${WORKSPACE_ID}/not-a-production-route`,
        owner: "release-routes",
        presentation: "authenticated",
        routerLiteral: "*",
        surface: "boundary"
      }
    ],
    family: "not-found",
    routerLiterals: ["*", "*"]
  },
  {
    audits: [
      {
        action: { kind: "required" },
        canonicalPath: "/",
        owner: "scaffold",
        presentation: "unauthenticated",
        routerLiteral: "<index>",
        surface: "primary"
      },
      {
        action: { kind: "required" },
        canonicalPath: `/w/${WORKSPACE_ID}/overview`,
        owner: "release-routes",
        presentation: "authenticated",
        routerLiteral: "overview",
        surface: "primary"
      }
    ],
    family: "overview",
    ownsIndexRoute: true,
    routerLiterals: ["overview", "releases"]
  },
  {
    audits: [
      {
        action: { kind: "required" },
        canonicalPath: "/pair",
        owner: "scaffold",
        presentation: "unauthenticated",
        routerLiteral: "pair",
        surface: "primary"
      }
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
        presentation: "authenticated",
        routerLiteral: "releases/:releaseId",
        surface: "primary"
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
        presentation: "authenticated",
        routerLiteral: "releases/:releaseId/preview",
        surface: "primary"
      }
    ],
    family: "release-preview",
    routerLiterals: ["releases/:releaseId/preview"]
  },
  {
    audits: [
      {
        action: { kind: "required" },
        canonicalPath: "/services",
        owner: "scaffold",
        presentation: "unauthenticated",
        routerLiteral: "services",
        surface: "primary"
      },
      {
        action: { kind: "required" },
        canonicalPath: "/services",
        owner: "release-routes",
        presentation: "authenticated",
        routerLiteral: "services",
        surface: "primary"
      }
    ],
    family: "services",
    routerLiterals: ["services"]
  },
  {
    audits: [
      {
        action: {
          kind: "none",
          reason: "Workspace settings requires a paired browser and exposes no action before authentication."
        },
        canonicalPath: `/w/${WORKSPACE_ID}/settings`,
        owner: "scaffold",
        presentation: "unauthenticated",
        routerLiteral: "settings",
        surface: "boundary"
      },
      {
        action: { kind: "required" },
        canonicalPath: `/w/${WORKSPACE_ID}/settings`,
        owner: "workspace-settings",
        presentation: "authenticated",
        routerLiteral: "settings",
        surface: "primary"
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
        presentation: "authenticated",
        routerLiteral: "timeline",
        surface: "primary"
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
        presentation: "authenticated",
        routerLiteral: "work",
        surface: "primary"
      }
    ],
    family: "work",
    routerLiterals: ["work"]
  }
]

/** Stable leaf-specific key used by browser owners to prove every assigned presentation actually ran. */
export const productionRouteAuditKey = (
  audit: Pick<ProductionRouteAuditRequirement, "family" | "presentation" | "routerLiteral">
): string => `${audit.routerLiteral}:${audit.family}:${audit.presentation}`

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
    throw new Error(`Production route audit ${family}:${presentation} is not owned by ${owner}`)
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

/** Exact leaves that deliberately expose distinct paired and unpaired presentations. */
export const CONTROL_CENTER_SESSION_SENSITIVE_ROUTE_LEAVES: ReadonlyArray<ProductionRouteLeaf> = [
  { family: "agent", routerLiteral: "agent" },
  { family: "authorized-share", routerLiteral: "shares/:workspaceId/:shareId" },
  { family: "atlassian-oauth-callback", routerLiteral: "services/oauth/atlassian/callback" },
  { family: "items", routerLiteral: "items" },
  { family: "services", routerLiteral: "services" },
  { family: "settings", routerLiteral: "settings" }
]

/** Literal leaves deliberately represented by another identical or redirecting browser presentation. */
export const CONTROL_CENTER_PRODUCTION_ROUTE_LEAF_EXEMPTIONS: ReadonlyArray<ProductionRouteLeafExemption> = [
  {
    family: "overview",
    routerLiteral: "releases",
    reason:
      "The top-level releases alias uses the same PortfolioOverview component as the audited index and redirects paired ready state to the workspace landing route."
  }
]

/** Families whose release acceptance must exercise a ready, route-owned primary surface. */
export const CONTROL_CENTER_READY_ROUTE_FAMILIES: ReadonlyArray<ProductionRouteFamily> = [
  "agent",
  "authorized-share",
  "item",
  "items",
  "overview",
  "pair",
  "release",
  "release-preview",
  "services",
  "settings",
  "timeline",
  "work"
]

/** Report missing session variants and ready surfaces without coupling the invariant to a test runner. */
export const productionRouteCoverageFailures = (
  descriptors: ReadonlyArray<ProductionRouteFamilyDescriptor>,
  sessionSensitiveLeaves: ReadonlyArray<ProductionRouteLeaf>,
  readyFamilies: ReadonlyArray<ProductionRouteFamily>
): ReadonlyArray<string> => {
  const failures: Array<string> = []
  const requiredPresentations: ReadonlyArray<ProductionRoutePresentation> = ["authenticated", "unauthenticated"]
  for (const { family, routerLiteral } of sessionSensitiveLeaves) {
    const presentations = new Set(
      descriptors
        .find((descriptor) => descriptor.family === family)
        ?.audits.filter((audit) => audit.routerLiteral === routerLiteral)
        .map(({ presentation }) => presentation)
    )
    for (const presentation of requiredPresentations) {
      if (!presentations.has(presentation)) {
        failures.push(`${family} (${routerLiteral}) is missing its ${presentation} presentation`)
      }
    }
  }
  for (const family of readyFamilies) {
    const descriptor = descriptors.find((candidate) => candidate.family === family)
    if (!descriptor?.audits.some(({ surface }) => surface === "primary")) {
      failures.push(`${family} is missing its primary ready surface`)
    }
  }
  return failures
}
