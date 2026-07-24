import { assert, describe, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { OpenApi } from "effect/unstable/httpapi"

import {
  AgentApiGroup,
  CompleteDiffContentRequest,
  ControlCenterApi,
  CreateAtlassianOAuthGrantRequest,
  DeliveryGraphApiGroup,
  DiffApiGroup,
  LiveEventsApiGroup,
  makeControlCenterApiClient,
  makeControlCenterApiUrls,
  MediaApiGroup,
  MutationCsrf,
  OpaqueMediaId,
  PluginListResponse,
  PluginOverviewResponse,
  PluginsApiGroup,
  PortfolioApiGroup,
  ReleaseAgentThreadCursor,
  SessionApiGroup,
  SessionCookieAuth,
  SessionId,
  SessionMutationAuth,
  SharesApiGroup,
  TimelineApiGroup
} from "../../src/api/index.js"
import { LedgerRevision } from "../../src/domain/deliveryGraph.js"
import {
  EvidenceId,
  PluginConnectionId,
  RelationshipId,
  RelationshipRepairProposalId,
  ReleaseId,
  ShareId,
  WorkspaceId
} from "../../src/domain/identifiers.js"
import { PluginRelativePathV1 } from "../../src/domain/plugins/events.js"
import { Revision, VendorImmutableId } from "../../src/domain/sourceRevision.js"

const middlewareKeys = (middlewares: ReadonlySet<{ readonly key: string }>): ReadonlyArray<string> =>
  Array.from(middlewares, ({ key }) => key)

const v1PluginListCompatibilityFixture: typeof PluginListResponse.Encoded = [{
  pluginConnectionId: "01890f6f-6d6a-7cc0-98d2-000000000098",
  providerAccountId: null,
  followedResourceId: null,
  providerId: "jira",
  displayName: "Delivery Jira",
  isEnabled: true,
  health: null,
  updatedAt: "2026-07-14T10:00:00.000Z"
}]

const pluginCatalogFieldCompatibilityFixture:
  (typeof PluginOverviewResponse.Encoded)["catalog"][number]["configurationFields"][number] = {
    key: "profile",
    label: "Profile",
    description: "Local configuration value.",
    kind: "text",
    scope: "adapter",
    required: true,
    defaultValue: "default",
    isReadOnly: false,
    minimum: null,
    maximum: null
  }

const firstPartyProviderIds: ReadonlyArray<
  (typeof PluginOverviewResponse.Encoded)["catalog"][number]["providerId"]
> = ["codecommit", "codepipeline", "jira", "confluence", "clockify"]

const pluginOverviewCompatibilityFixture: typeof PluginOverviewResponse.Encoded = {
  catalog: firstPartyProviderIds.map((providerId) => ({
    providerId,
    displayName: providerId,
    description: `Configure ${providerId}.`,
    configurationFields: [pluginCatalogFieldCompatibilityFixture]
  })),
  connections: v1PluginListCompatibilityFixture,
  accounts: []
}

describe("ControlCenterApi contract", () => {
  it("accepts only one or both distinct Atlassian OAuth providers", () => {
    const isCreateGrantRequest = Schema.is(CreateAtlassianOAuthGrantRequest)

    assert.isTrue(isCreateGrantRequest({ providers: ["jira"] }))
    assert.isTrue(isCreateGrantRequest({ providers: ["confluence"] }))
    assert.isTrue(isCreateGrantRequest({ providers: ["jira", "confluence"] }))
    assert.isTrue(isCreateGrantRequest({
      providers: ["jira", "confluence"],
      configuration: { clientId: "oauth-client", clientSecret: "oauth-secret" }
    }))
    assert.isFalse(isCreateGrantRequest({ providers: [] }))
    assert.isFalse(isCreateGrantRequest({ providers: ["jira", "jira"] }))
    assert.isFalse(isCreateGrantRequest({ providers: ["jira", "bitbucket"] }))
    assert.isFalse(isCreateGrantRequest({
      providers: ["jira"],
      configuration: { clientId: "", clientSecret: "oauth-secret" }
    }))
    assert.isFalse(isCreateGrantRequest({
      providers: ["jira"],
      configuration: { clientId: "oauth-client", clientSecret: "" }
    }))
  })

  it("publishes stable error discriminators and HTTP statuses", () => {
    const specification = OpenApi.fromApi(ControlCenterApi)
    const configurationPath = specification.paths["/api/v1/plugins/{pluginConnectionId}/configuration"]
    assert.isDefined(configurationPath)
    assert.isDefined(configurationPath.patch)
    assert.deepStrictEqual(Object.keys(configurationPath.patch.responses), [
      "200",
      "400",
      "401",
      "403",
      "404",
      "408",
      "409",
      "413",
      "429",
      "503"
    ])

    const eventsPath = specification.paths["/api/v1/events"]
    assert.isDefined(eventsPath)
    assert.isDefined(eventsPath.get)
    assert.deepStrictEqual(Object.keys(eventsPath.get.responses), ["200", "400", "401", "403", "408", "429", "503"])
    assert.isDefined(eventsPath.get.responses["200"])
    assert.isDefined(eventsPath.get.responses["200"].content)
    assert.isDefined(eventsPath.get.responses["200"].content["text/event-stream"])
    assert.deepStrictEqual(
      eventsPath.get.parameters?.map(({ in: location, name, required }) => ({ location, name, required })),
      [
        { location: "header", name: "last-event-id", required: false },
        { location: "query", name: "after", required: false }
      ]
    )

    const csvExportPath = specification.paths["/api/v1/timeline/export.csv"]
    assert.isDefined(csvExportPath)
    assert.isDefined(csvExportPath.get)
    assert.isDefined(csvExportPath.get.responses["200"]?.content?.["text/csv; charset=utf-8"])
    assert.deepStrictEqual(
      csvExportPath.get.parameters?.map(({ in: location, name, required }) => ({ location, name, required })),
      [
        { location: "query", name: "actor", required: false },
        { location: "query", name: "from", required: false },
        { location: "query", name: "limit", required: true },
        { location: "query", name: "to", required: false }
      ]
    )
    const jsonExportPath = specification.paths["/api/v1/timeline/export.json"]
    assert.isDefined(jsonExportPath)
    assert.isDefined(jsonExportPath.get)
    assert.isDefined(jsonExportPath.get.responses["200"]?.content?.["application/json; charset=utf-8"])

    const diffInventoryPath =
      specification.paths["/api/v1/diffs/{pluginConnectionId}/pull-requests/{vendorImmutableId}/inventory"]
    assert.isDefined(diffInventoryPath)
    assert.isDefined(diffInventoryPath.get)
    assert.deepStrictEqual(Object.keys(diffInventoryPath.get.responses), [
      "200",
      "400",
      "401",
      "403",
      "404",
      "408",
      "409",
      "429",
      "503"
    ])

    const diffContentPath =
      specification.paths["/api/v1/diffs/{pluginConnectionId}/pull-requests/{vendorImmutableId}/content"]
    assert.isDefined(diffContentPath)
    assert.isUndefined(diffContentPath.get)
    assert.isDefined(diffContentPath.post)
    assert.isDefined(diffContentPath.post.requestBody)
    assert.deepStrictEqual(Object.keys(diffContentPath.post.responses), [
      "200",
      "400",
      "401",
      "403",
      "404",
      "408",
      "409",
      "413",
      "429",
      "503"
    ])

    const agentTurnPath = specification.paths["/api/v1/agent/releases/{releaseId}/turns"]
    assert.isDefined(agentTurnPath)
    assert.isDefined(agentTurnPath.post)
    assert.deepStrictEqual(Object.keys(agentTurnPath.post.responses), [
      "200",
      "400",
      "401",
      "403",
      "404",
      "408",
      "413",
      "429",
      "503"
    ])
    const agentJobPath = specification.paths["/api/v1/agent/releases/{releaseId}/jobs"]
    assert.isDefined(agentJobPath)
    assert.isDefined(agentJobPath.post)
    assert.deepStrictEqual(Object.keys(agentJobPath.post.responses), [
      "202",
      "400",
      "401",
      "403",
      "404",
      "408",
      "413",
      "429",
      "503"
    ])
    const agentThreadPath = specification.paths["/api/v1/agent/releases/{releaseId}/thread/events"]
    assert.isDefined(agentThreadPath)
    assert.isDefined(agentThreadPath.get)
    assert.deepStrictEqual(Object.keys(agentThreadPath.get.responses), [
      "200",
      "400",
      "401",
      "403",
      "404",
      "408",
      "429",
      "503"
    ])

    const createRepairProposalPath =
      specification.paths["/api/v1/relationships/releases/{releaseId}/repair-candidates/{relationshipId}/proposals"]
    assert.isDefined(createRepairProposalPath)
    assert.isDefined(createRepairProposalPath.post)
    assert.deepStrictEqual(Object.keys(createRepairProposalPath.post.responses), [
      "200",
      "400",
      "401",
      "403",
      "404",
      "408",
      "409",
      "413",
      "503"
    ])

    const reviewRepairProposalPath = specification.paths["/api/v1/relationships/repair-proposals/{proposalId}/reviews"]
    assert.isDefined(reviewRepairProposalPath)
    assert.isDefined(reviewRepairProposalPath.post)
    assert.deepStrictEqual(Object.keys(reviewRepairProposalPath.post.responses), [
      "200",
      "400",
      "401",
      "403",
      "404",
      "408",
      "409",
      "413",
      "503"
    ])

    const applyRepairProposalPath =
      specification.paths["/api/v1/relationships/repair-proposals/{proposalId}/applications"]
    assert.isDefined(applyRepairProposalPath)
    assert.isDefined(applyRepairProposalPath.post)
    assert.deepStrictEqual(Object.keys(applyRepairProposalPath.post.responses), [
      "200",
      "400",
      "401",
      "403",
      "404",
      "408",
      "409",
      "503"
    ])
  })

  it("keeps the ten API groups and endpoint routes explicit", () => {
    assert.strictEqual(ControlCenterApi.identifier, "ControlCenterApi")
    assert.deepStrictEqual(Object.keys(ControlCenterApi.groups), [
      "session",
      "shares",
      "plugins",
      "portfolio",
      "deliveryGraph",
      "diff",
      "media",
      "liveEvents",
      "timeline",
      "agent"
    ])

    assert.deepStrictEqual(
      Object.entries(SessionApiGroup.endpoints).map(([identifier, { method, path }]) => [identifier, method, path]),
      [
        ["pair", "POST", "/api/v1/session/pair"],
        ["current", "GET", "/api/v1/session/current"],
        ["list", "GET", "/api/v1/session"],
        ["revoke", "DELETE", "/api/v1/session/:sessionId"],
        ["logout", "POST", "/api/v1/session/logout"]
      ]
    )
    assert.deepStrictEqual(
      Object.entries(SharesApiGroup.endpoints).map(([identifier, { method, path }]) => [identifier, method, path]),
      [
        ["create", "POST", "/api/v1/shares"],
        ["resolve", "GET", "/api/v1/shares/:workspaceId/:shareId"],
        ["revoke", "DELETE", "/api/v1/shares/:workspaceId/:shareId"]
      ]
    )
    assert.deepStrictEqual(
      Object.entries(PluginsApiGroup.endpoints).map(([identifier, { method, path }]) => [identifier, method, path]),
      [
        ["list", "GET", "/api/v1/plugins"],
        ["overview", "GET", "/api/v1/plugins/overview"],
        ["discoverAwsProfiles", "GET", "/api/v1/plugins/discovery/aws-profiles"],
        ["discoverAwsResources", "POST", "/api/v1/plugins/discovery/aws-resources"],
        ["discoverAtlassianProfiles", "GET", "/api/v1/plugins/discovery/atlassian-profiles"],
        ["createAtlassianOAuthGrant", "POST", "/api/v1/plugins/oauth/atlassian/grants"],
        [
          "exchangeAtlassianOAuthGrant",
          "POST",
          "/api/v1/plugins/oauth/atlassian/grants/:grantId/exchange"
        ],
        [
          "completeAtlassianOAuthGrant",
          "POST",
          "/api/v1/plugins/oauth/atlassian/grants/:grantId/complete"
        ],
        ["createConnection", "POST", "/api/v1/plugins/connections"],
        ["createConnections", "POST", "/api/v1/plugins/connections/batch"],
        ["setConnectionEnabled", "PATCH", "/api/v1/plugins/connections/:pluginConnectionId"],
        ["health", "GET", "/api/v1/plugins/:pluginConnectionId/health"],
        ["testConnection", "POST", "/api/v1/plugins/:pluginConnectionId/test"],
        ["synchronization", "GET", "/api/v1/plugins/:pluginConnectionId/synchronization"],
        ["synchronizeConnection", "POST", "/api/v1/plugins/:pluginConnectionId/sync"],
        ["configurationMetadata", "GET", "/api/v1/plugins/:pluginConnectionId/configuration-metadata"],
        ["configuration", "GET", "/api/v1/plugins/:pluginConnectionId/configuration"],
        ["patchConfiguration", "PATCH", "/api/v1/plugins/:pluginConnectionId/configuration"]
      ]
    )
    assert.deepStrictEqual(
      Object.entries(PortfolioApiGroup.endpoints).map(([identifier, { method, path }]) => [identifier, method, path]),
      [["snapshot", "GET", "/api/v1/portfolio/snapshot"]]
    )
    assert.deepStrictEqual(
      Object.entries(DeliveryGraphApiGroup.endpoints).map(([identifier, { method, path }]) => [
        identifier,
        method,
        path
      ]),
      [
        ["workspaceEntityProjections", "GET", "/api/v1/items"],
        ["workspaceEntity", "GET", "/api/v1/items/:entityId"],
        ["releaseSlice", "GET", "/api/v1/relationships/releases/:releaseId"],
        ["repairCandidates", "GET", "/api/v1/relationships/releases/:releaseId/repair-candidates"],
        [
          "repairProposalDraft",
          "GET",
          "/api/v1/relationships/releases/:releaseId/repair-candidates/:relationshipId/proposal-draft"
        ],
        [
          "createRepairProposal",
          "POST",
          "/api/v1/relationships/releases/:releaseId/repair-candidates/:relationshipId/proposals"
        ],
        ["listRepairProposals", "GET", "/api/v1/relationships/releases/:releaseId/repair-proposals"],
        ["getRepairProposal", "GET", "/api/v1/relationships/repair-proposals/:proposalId"],
        ["reviewRepairProposal", "POST", "/api/v1/relationships/repair-proposals/:proposalId/reviews"],
        ["applyRepairProposal", "POST", "/api/v1/relationships/repair-proposals/:proposalId/applications"],
        ["relationship", "GET", "/api/v1/relationships/:relationshipId"],
        ["relationshipHistory", "GET", "/api/v1/relationships/:relationshipId/history"],
        ["evidence", "GET", "/api/v1/evidence/:evidenceId"]
      ]
    )
    assert.deepStrictEqual(
      Object.entries(DiffApiGroup.endpoints).map(([identifier, { method, path }]) => [
        identifier,
        method,
        path
      ]),
      [
        [
          "inventory",
          "GET",
          "/api/v1/diffs/:pluginConnectionId/pull-requests/:vendorImmutableId/inventory"
        ],
        [
          "content",
          "POST",
          "/api/v1/diffs/:pluginConnectionId/pull-requests/:vendorImmutableId/content"
        ]
      ]
    )
    assert.deepStrictEqual(
      Object.entries(MediaApiGroup.endpoints).map(([identifier, { method, path }]) => [identifier, method, path]),
      [["read", "GET", "/api/v1/media/:mediaId"]]
    )
    assert.deepStrictEqual(
      Object.entries(LiveEventsApiGroup.endpoints).map(([identifier, { method, path }]) => [identifier, method, path]),
      [["stream", "GET", "/api/v1/events"]]
    )
    assert.deepStrictEqual(
      Object.entries(TimelineApiGroup.endpoints).map(([identifier, { method, path }]) => [identifier, method, path]),
      [
        ["page", "GET", "/api/v1/timeline"],
        ["detail", "GET", "/api/v1/timeline/events/:eventKey"],
        ["exportCsv", "GET", "/api/v1/timeline/export.csv"],
        ["exportJson", "GET", "/api/v1/timeline/export.json"]
      ]
    )
    assert.deepStrictEqual(
      Object.entries(AgentApiGroup.endpoints).map(([identifier, { method, path }]) => [identifier, method, path]),
      [
        ["turn", "POST", "/api/v1/agent/releases/:releaseId/turns"],
        ["enqueueJob", "POST", "/api/v1/agent/releases/:releaseId/jobs"],
        ["replayThread", "GET", "/api/v1/agent/releases/:releaseId/thread/events"]
      ]
    )
  })

  it("preserves the v1 plugin-list payload and exposes the catalog overview additively", () => {
    const currentPluginListFixture = v1PluginListCompatibilityFixture.map((connection) => ({
      ...connection,
      supportsSynchronization: false
    }))

    assert.deepStrictEqual(
      Schema.encodeSync(PluginListResponse)(
        Schema.decodeUnknownSync(PluginListResponse)(v1PluginListCompatibilityFixture)
      ),
      currentPluginListFixture
    )
    assert.deepStrictEqual(
      Schema.encodeSync(PluginOverviewResponse)(
        Schema.decodeUnknownSync(PluginOverviewResponse)(pluginOverviewCompatibilityFixture)
      ),
      {
        ...pluginOverviewCompatibilityFixture,
        connections: currentPluginListFixture
      }
    )

    const specification = OpenApi.fromApi(ControlCenterApi)
    assert.isDefined(specification.paths["/api/v1/plugins"]?.get)
    assert.isDefined(specification.paths["/api/v1/plugins/overview"]?.get)
    assert.isDefined(specification.paths["/api/v1/plugins/connections/{pluginConnectionId}"]?.patch)
  })

  it("requires cookie auth for private reads and separate CSRF proof for mutations", () => {
    const middlewareByEndpoint = (
      endpoints: Readonly<Record<string, { readonly middlewares: ReadonlySet<{ readonly key: string }> }>>
    ) =>
      Object.fromEntries(
        Object.entries(endpoints).map(([identifier, endpoint]) => [identifier, middlewareKeys(endpoint.middlewares)])
      )

    assert.deepStrictEqual(middlewareByEndpoint(SessionApiGroup.endpoints), {
      pair: [],
      current: [SessionCookieAuth.key],
      list: [SessionCookieAuth.key],
      revoke: [SessionCookieAuth.key, MutationCsrf.key],
      logout: [SessionCookieAuth.key, MutationCsrf.key]
    })
    assert.deepStrictEqual(middlewareByEndpoint(SharesApiGroup.endpoints), {
      create: [SessionCookieAuth.key, SessionMutationAuth.key],
      resolve: [SessionCookieAuth.key],
      revoke: [SessionCookieAuth.key, SessionMutationAuth.key]
    })
    assert.deepStrictEqual(middlewareByEndpoint(PluginsApiGroup.endpoints), {
      list: [SessionCookieAuth.key],
      overview: [SessionCookieAuth.key],
      discoverAwsProfiles: [SessionCookieAuth.key],
      discoverAwsResources: [SessionCookieAuth.key, SessionMutationAuth.key],
      discoverAtlassianProfiles: [SessionCookieAuth.key],
      createAtlassianOAuthGrant: [SessionCookieAuth.key, SessionMutationAuth.key],
      exchangeAtlassianOAuthGrant: [SessionCookieAuth.key, SessionMutationAuth.key],
      completeAtlassianOAuthGrant: [SessionCookieAuth.key, SessionMutationAuth.key],
      createConnection: [SessionCookieAuth.key, SessionMutationAuth.key],
      createConnections: [SessionCookieAuth.key, SessionMutationAuth.key],
      setConnectionEnabled: [SessionCookieAuth.key, SessionMutationAuth.key],
      health: [SessionCookieAuth.key],
      testConnection: [SessionCookieAuth.key, SessionMutationAuth.key],
      synchronization: [SessionCookieAuth.key],
      synchronizeConnection: [SessionCookieAuth.key, SessionMutationAuth.key],
      configurationMetadata: [SessionCookieAuth.key],
      configuration: [SessionCookieAuth.key],
      patchConfiguration: [SessionCookieAuth.key, SessionMutationAuth.key]
    })
    assert.deepStrictEqual(middlewareByEndpoint(PortfolioApiGroup.endpoints), {
      snapshot: [SessionCookieAuth.key]
    })
    assert.deepStrictEqual(middlewareByEndpoint(DeliveryGraphApiGroup.endpoints), {
      workspaceEntityProjections: [SessionCookieAuth.key],
      workspaceEntity: [SessionCookieAuth.key],
      releaseSlice: [SessionCookieAuth.key],
      repairCandidates: [SessionCookieAuth.key],
      repairProposalDraft: [SessionCookieAuth.key],
      createRepairProposal: [SessionCookieAuth.key, SessionMutationAuth.key],
      listRepairProposals: [SessionCookieAuth.key],
      getRepairProposal: [SessionCookieAuth.key],
      reviewRepairProposal: [SessionCookieAuth.key, SessionMutationAuth.key],
      applyRepairProposal: [SessionCookieAuth.key, SessionMutationAuth.key],
      relationship: [SessionCookieAuth.key],
      relationshipHistory: [SessionCookieAuth.key],
      evidence: [SessionCookieAuth.key]
    })
    assert.deepStrictEqual(middlewareByEndpoint(DiffApiGroup.endpoints), {
      inventory: [SessionCookieAuth.key],
      content: [SessionCookieAuth.key]
    })
    assert.deepStrictEqual(middlewareByEndpoint(MediaApiGroup.endpoints), {
      read: [SessionCookieAuth.key]
    })
    assert.deepStrictEqual(middlewareByEndpoint(LiveEventsApiGroup.endpoints), {
      stream: [SessionCookieAuth.key]
    })
    assert.deepStrictEqual(middlewareByEndpoint(TimelineApiGroup.endpoints), {
      page: [SessionCookieAuth.key],
      detail: [SessionCookieAuth.key],
      exportCsv: [SessionCookieAuth.key],
      exportJson: [SessionCookieAuth.key]
    })
    assert.deepStrictEqual(middlewareByEndpoint(AgentApiGroup.endpoints), {
      turn: [SessionCookieAuth.key, SessionMutationAuth.key],
      enqueueJob: [SessionCookieAuth.key, SessionMutationAuth.key],
      replayThread: [SessionCookieAuth.key]
    })

    assert.strictEqual(SessionCookieAuth.security.sessionCookie._tag, "ApiKey")
    assert.strictEqual(SessionCookieAuth.security.sessionCookie.in, "cookie")
    assert.strictEqual(SessionCookieAuth.security.sessionCookie.key, "cc_session")
    assert.strictEqual(MutationCsrf.security.csrfToken._tag, "ApiKey")
    assert.strictEqual(MutationCsrf.security.csrfToken.in, "header")
    assert.strictEqual(MutationCsrf.security.csrfToken.key, "x-csrf-token")
  })

  it("derives browser-safe URLs and a generated-client constructor", () => {
    const sessionId = Schema.decodeSync(SessionId)("01890f6f-6d6a-7cc0-98d2-000000000091")
    const pluginConnectionId = Schema.decodeSync(PluginConnectionId)("01890f6f-6d6a-7cc0-98d2-000000000092")
    const mediaId = Schema.decodeSync(OpaqueMediaId)(`media_${"ab".repeat(32)}`)
    const releaseId = Schema.decodeSync(ReleaseId)("01890f6f-6d6a-7cc0-98d2-000000000093")
    const relationshipId = Schema.decodeSync(RelationshipId)("01890f6f-6d6a-7cc0-98d2-000000000094")
    const proposalId = Schema.decodeSync(RelationshipRepairProposalId)("01890f6f-6d6a-7cc0-98d2-000000000096")
    const revision = Schema.decodeSync(LedgerRevision)(1)
    const evidenceId = Schema.decodeSync(EvidenceId)("01890f6f-6d6a-7cc0-98d2-000000000095")
    const shareId = Schema.decodeSync(ShareId)("01890f6f-6d6a-7cc0-98d2-000000000097")
    const workspaceId = Schema.decodeSync(WorkspaceId)("01890f6f-6d6a-7cc0-98d2-000000000001")
    const urls = makeControlCenterApiUrls({ baseUrl: "https://control.example" })
    const vendorImmutableId = VendorImmutableId.make("184")

    assert.strictEqual(urls.session.current(), "https://control.example/api/v1/session/current")
    assert.strictEqual(
      urls.session.revoke({ params: { sessionId } }),
      "https://control.example/api/v1/session/01890f6f-6d6a-7cc0-98d2-000000000091"
    )
    assert.strictEqual(
      urls.shares.resolve({ params: { workspaceId, shareId } }),
      "https://control.example/api/v1/shares/01890f6f-6d6a-7cc0-98d2-000000000001/01890f6f-6d6a-7cc0-98d2-000000000097"
    )
    assert.strictEqual(
      urls.plugins.health({ params: { pluginConnectionId } }),
      "https://control.example/api/v1/plugins/01890f6f-6d6a-7cc0-98d2-000000000092/health"
    )
    assert.strictEqual(
      urls.plugins.synchronizeConnection({ params: { pluginConnectionId } }),
      "https://control.example/api/v1/plugins/01890f6f-6d6a-7cc0-98d2-000000000092/sync"
    )
    const contentUrl = urls.diff.content({
      params: { pluginConnectionId, vendorImmutableId }
    })
    assert.strictEqual(
      contentUrl,
      "https://control.example/api/v1/diffs/01890f6f-6d6a-7cc0-98d2-000000000092/pull-requests/184/content"
    )
    assert.isBelow(contentUrl.length, 8 * 1024)
    const maximumPath = PluginRelativePathV1.make("a".repeat(4_096))
    assert.isTrue(
      Schema.is(CompleteDiffContentRequest)({
        revision: Revision.make("revision-9"),
        anchor: `sha256:${"a".repeat(64)}`,
        path: maximumPath,
        previousPath: maximumPath,
        status: "renamed",
        side: "before",
        offset: 0,
        length: 1_048_576
      })
    )
    assert.strictEqual(urls.plugins.list(), "https://control.example/api/v1/plugins")
    assert.strictEqual(urls.plugins.overview(), "https://control.example/api/v1/plugins/overview")
    assert.strictEqual(
      urls.plugins.setConnectionEnabled({ params: { pluginConnectionId } }),
      "https://control.example/api/v1/plugins/connections/01890f6f-6d6a-7cc0-98d2-000000000092"
    )
    assert.strictEqual(
      urls.media.read({ params: { mediaId } }),
      `https://control.example/api/v1/media/media_${"ab".repeat(32)}`
    )
    assert.strictEqual(urls.timeline.page({ query: {} }), "https://control.example/api/v1/timeline")
    assert.strictEqual(
      urls.timeline.exportCsv({ query: { actor: "human", limit: 1000 } }),
      "https://control.example/api/v1/timeline/export.csv?actor=human&limit=1000"
    )
    assert.strictEqual(
      urls.timeline.exportJson({ query: { limit: 25 } }),
      "https://control.example/api/v1/timeline/export.json?limit=25"
    )
    assert.strictEqual(
      urls.agent.turn({ params: { releaseId } }),
      "https://control.example/api/v1/agent/releases/01890f6f-6d6a-7cc0-98d2-000000000093/turns"
    )
    assert.strictEqual(
      urls.agent.enqueueJob({ params: { releaseId } }),
      "https://control.example/api/v1/agent/releases/01890f6f-6d6a-7cc0-98d2-000000000093/jobs"
    )
    assert.strictEqual(
      urls.agent.replayThread({
        params: { releaseId },
        query: { after: ReleaseAgentThreadCursor.make(12), limit: 32 }
      }),
      "https://control.example/api/v1/agent/releases/01890f6f-6d6a-7cc0-98d2-000000000093/thread/events?after=12&limit=32"
    )
    assert.strictEqual(
      urls.deliveryGraph.relationship({ params: { relationshipId }, query: {} }),
      "https://control.example/api/v1/relationships/01890f6f-6d6a-7cc0-98d2-000000000094"
    )
    assert.strictEqual(
      urls.deliveryGraph.repairCandidates({ params: { releaseId }, query: {} }),
      "https://control.example/api/v1/relationships/releases/01890f6f-6d6a-7cc0-98d2-000000000093/repair-candidates"
    )
    assert.strictEqual(
      urls.deliveryGraph.repairProposalDraft({
        params: { releaseId, relationshipId },
        query: { revision }
      }),
      "https://control.example/api/v1/relationships/releases/01890f6f-6d6a-7cc0-98d2-000000000093/repair-candidates/01890f6f-6d6a-7cc0-98d2-000000000094/proposal-draft?revision=1"
    )
    assert.strictEqual(
      urls.deliveryGraph.createRepairProposal({
        params: { releaseId, relationshipId }
      }),
      "https://control.example/api/v1/relationships/releases/01890f6f-6d6a-7cc0-98d2-000000000093/repair-candidates/01890f6f-6d6a-7cc0-98d2-000000000094/proposals"
    )
    assert.strictEqual(
      urls.deliveryGraph.listRepairProposals({ params: { releaseId }, query: { status: "pending" } }),
      "https://control.example/api/v1/relationships/releases/01890f6f-6d6a-7cc0-98d2-000000000093/repair-proposals?status=pending"
    )
    assert.strictEqual(
      urls.deliveryGraph.getRepairProposal({ params: { proposalId } }),
      "https://control.example/api/v1/relationships/repair-proposals/01890f6f-6d6a-7cc0-98d2-000000000096"
    )
    assert.strictEqual(
      urls.deliveryGraph.reviewRepairProposal({ params: { proposalId } }),
      "https://control.example/api/v1/relationships/repair-proposals/01890f6f-6d6a-7cc0-98d2-000000000096/reviews"
    )
    assert.strictEqual(
      urls.deliveryGraph.applyRepairProposal({ params: { proposalId } }),
      "https://control.example/api/v1/relationships/repair-proposals/01890f6f-6d6a-7cc0-98d2-000000000096/applications"
    )
    assert.strictEqual(
      urls.deliveryGraph.evidence({ params: { evidenceId } }),
      "https://control.example/api/v1/evidence/01890f6f-6d6a-7cc0-98d2-000000000095"
    )
    assert.isTrue(Effect.isEffect(makeControlCenterApiClient({ baseUrl: "https://control.example" })))
  })
})
