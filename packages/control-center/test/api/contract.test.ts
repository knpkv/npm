import { assert, describe, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { OpenApi } from "effect/unstable/httpapi"

import {
  ControlCenterApi,
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
import { PluginConnectionId } from "../../src/domain/identifiers.js"

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
  })

  it("keeps the four API groups and endpoint routes explicit", () => {
    assert.strictEqual(ControlCenterApi.identifier, "ControlCenterApi")
    assert.deepStrictEqual(Object.keys(ControlCenterApi.groups), ["session", "plugins", "portfolio", "media"])

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
      Object.entries(MediaApiGroup.endpoints).map(([identifier, { method, path }]) => [identifier, method, path]),
      [["read", "GET", "/api/v1/media/:mediaId"]]
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
    assert.deepStrictEqual(middlewareByEndpoint(MediaApiGroup.endpoints), {
      read: [SessionCookieAuth.key]
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
    assert.isTrue(Effect.isEffect(makeControlCenterApiClient({ baseUrl: "https://control.example" })))
  })
})
