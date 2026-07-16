import { assert, describe, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { OpenApi } from "effect/unstable/httpapi"

import {
  AgentApiGroup,
  ControlCenterApi,
  DeliveryGraphApiGroup,
  LiveEventsApiGroup,
  makeControlCenterApiClient,
  makeControlCenterApiUrls,
  MediaApiGroup,
  MutationCsrf,
  OpaqueMediaId,
  PluginsApiGroup,
  PortfolioApiGroup,
  SessionApiGroup,
  SessionCookieAuth,
  SessionId,
  SessionMutationAuth
} from "../../src/api/index.js"
import { LedgerRevision } from "../../src/domain/deliveryGraph.js"
import { EvidenceId, PluginConnectionId, RelationshipId, ReleaseId } from "../../src/domain/identifiers.js"

const middlewareKeys = (middlewares: ReadonlySet<{ readonly key: string }>): ReadonlyArray<string> =>
  Array.from(middlewares, ({ key }) => key)

describe("ControlCenterApi contract", () => {
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
  })

  it("keeps the seven API groups and endpoint routes explicit", () => {
    assert.strictEqual(ControlCenterApi.identifier, "ControlCenterApi")
    assert.deepStrictEqual(Object.keys(ControlCenterApi.groups), [
      "session",
      "plugins",
      "portfolio",
      "deliveryGraph",
      "media",
      "liveEvents",
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
      Object.entries(PluginsApiGroup.endpoints).map(([identifier, { method, path }]) => [identifier, method, path]),
      [
        ["list", "GET", "/api/v1/plugins"],
        ["health", "GET", "/api/v1/plugins/:pluginConnectionId/health"],
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
        ["releaseSlice", "GET", "/api/v1/relationships/releases/:releaseId"],
        ["repairCandidates", "GET", "/api/v1/relationships/releases/:releaseId/repair-candidates"],
        [
          "repairProposalDraft",
          "GET",
          "/api/v1/relationships/releases/:releaseId/repair-candidates/:relationshipId/proposal-draft"
        ],
        ["relationship", "GET", "/api/v1/relationships/:relationshipId"],
        ["relationshipHistory", "GET", "/api/v1/relationships/:relationshipId/history"],
        ["evidence", "GET", "/api/v1/evidence/:evidenceId"]
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
      Object.entries(AgentApiGroup.endpoints).map(([identifier, { method, path }]) => [identifier, method, path]),
      [["turn", "POST", "/api/v1/agent/releases/:releaseId/turns"]]
    )
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
    assert.deepStrictEqual(middlewareByEndpoint(PluginsApiGroup.endpoints), {
      list: [SessionCookieAuth.key],
      health: [SessionCookieAuth.key],
      configurationMetadata: [SessionCookieAuth.key],
      configuration: [SessionCookieAuth.key],
      patchConfiguration: [SessionCookieAuth.key, SessionMutationAuth.key]
    })
    assert.deepStrictEqual(middlewareByEndpoint(PortfolioApiGroup.endpoints), {
      snapshot: [SessionCookieAuth.key]
    })
    assert.deepStrictEqual(middlewareByEndpoint(DeliveryGraphApiGroup.endpoints), {
      releaseSlice: [SessionCookieAuth.key],
      repairCandidates: [SessionCookieAuth.key],
      repairProposalDraft: [SessionCookieAuth.key],
      relationship: [SessionCookieAuth.key],
      relationshipHistory: [SessionCookieAuth.key],
      evidence: [SessionCookieAuth.key]
    })
    assert.deepStrictEqual(middlewareByEndpoint(MediaApiGroup.endpoints), {
      read: [SessionCookieAuth.key]
    })
    assert.deepStrictEqual(middlewareByEndpoint(LiveEventsApiGroup.endpoints), {
      stream: [SessionCookieAuth.key]
    })
    assert.deepStrictEqual(middlewareByEndpoint(AgentApiGroup.endpoints), {
      turn: [SessionCookieAuth.key, SessionMutationAuth.key]
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
    const revision = Schema.decodeSync(LedgerRevision)(1)
    const evidenceId = Schema.decodeSync(EvidenceId)("01890f6f-6d6a-7cc0-98d2-000000000095")
    const urls = makeControlCenterApiUrls({ baseUrl: "https://control.example" })

    assert.strictEqual(urls.session.current(), "https://control.example/api/v1/session/current")
    assert.strictEqual(
      urls.session.revoke({ params: { sessionId } }),
      "https://control.example/api/v1/session/01890f6f-6d6a-7cc0-98d2-000000000091"
    )
    assert.strictEqual(
      urls.plugins.health({ params: { pluginConnectionId } }),
      "https://control.example/api/v1/plugins/01890f6f-6d6a-7cc0-98d2-000000000092/health"
    )
    assert.strictEqual(
      urls.media.read({ params: { mediaId } }),
      `https://control.example/api/v1/media/media_${"ab".repeat(32)}`
    )
    assert.strictEqual(
      urls.agent.turn({ params: { releaseId } }),
      "https://control.example/api/v1/agent/releases/01890f6f-6d6a-7cc0-98d2-000000000093/turns"
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
      urls.deliveryGraph.evidence({ params: { evidenceId } }),
      "https://control.example/api/v1/evidence/01890f6f-6d6a-7cc0-98d2-000000000095"
    )
    assert.isTrue(Effect.isEffect(makeControlCenterApiClient({ baseUrl: "https://control.example" })))
  })
})
