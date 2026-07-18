import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert, describe, it } from "@effect/vitest"
import { CONFLUENCE_SCOPES, JIRA_SCOPES } from "@knpkv/atlassian-common/auth"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import * as Ref from "effect/Ref"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"

import { AtlassianOAuthGrantId } from "../../src/api/plugins.js"
import { SessionId, WorkspaceId } from "../../src/domain/identifiers.js"
import { makeAtlassianOAuthGrants } from "../../src/server/plugins/atlassian/AtlassianOAuthGrants.js"

const MAXIMUM_PENDING_GRANTS = 20
const owner = {
  sessionId: SessionId.make("0198f6e1-4de2-7a20-8a64-576c88bd9784"),
  workspaceId: WorkspaceId.make("0198f6e1-4de2-7a20-8a64-576c88bd9785")
}

const writeSharedOAuthConfiguration = Effect.fn("test.writeSharedOAuthConfiguration")(function*(configHome: string) {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  for (const storeName of ["jira-cli", "confluence-to-markdown"]) {
    const store = path.join(configHome, "atlassian", storeName)
    yield* fileSystem.makeDirectory(store, { recursive: true })
    yield* fileSystem.writeFileString(
      path.join(store, "oauth.json"),
      JSON.stringify({ clientId: "client-id", clientSecret: "client-secret" })
    )
  }
})

describe("AtlassianOAuthGrants capacity", () => {
  it.effect("reserves capacity while authorization grants are exchanged", () =>
    Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "control-center-atlassian-cap-" })
      const configHome = path.join(home, "config")
      yield* writeSharedOAuthConfiguration(configHome)
      const configProvider = ConfigProvider.fromUnknown({ HOME: home, XDG_CONFIG_HOME: configHome })
      const exchangeRequests = yield* Ref.make(0)
      const allExchangesStarted = yield* Deferred.make<void>()
      const releaseExchanges = yield* Deferred.make<void>()
      const providerClient = HttpClient.make((request) =>
        Effect.gen(function*() {
          const body = request.url.endsWith("/oauth/token")
            ? yield* Effect.gen(function*() {
              const started = yield* Ref.updateAndGet(exchangeRequests, (count) => count + 1)
              if (started === MAXIMUM_PENDING_GRANTS) {
                yield* Deferred.succeed(allExchangesStarted, undefined)
              }
              yield* Deferred.await(releaseExchanges)
              return {
                access_token: `access-${started}`,
                refresh_token: `refresh-${started}`,
                expires_in: 3_600,
                scope: [...JIRA_SCOPES, ...CONFLUENCE_SCOPES].join(" "),
                token_type: "Bearer"
              }
            })
            : request.url.endsWith("/accessible-resources")
            ? [{
              id: "cloud-1",
              name: "Acme",
              url: "https://acme.atlassian.net/",
              scopes: [...JIRA_SCOPES, ...CONFLUENCE_SCOPES]
            }]
            : { account_id: "account-1", name: "Avery Bell", email: "avery@example.com" }
          return HttpClientResponse.fromWeb(
            request,
            new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })
          )
        })
      )
      const grants = yield* makeAtlassianOAuthGrants().pipe(
        Effect.provideService(HttpClient.HttpClient, providerClient)
      )
      const grantIds = yield* Effect.forEach(
        Array.from({ length: MAXIMUM_PENDING_GRANTS }),
        () =>
          grants.start(owner, "http://127.0.0.1:4173", ["jira", "confluence"]).pipe(
            Effect.provideService(ConfigProvider.ConfigProvider, configProvider),
            Effect.flatMap((started) =>
              started._tag === "ready"
                ? Schema.decodeUnknownEffect(AtlassianOAuthGrantId)(
                  new URL(started.authorizationUrl).searchParams.get("state")
                )
                : Effect.die("shared OAuth configuration was not loaded")
            )
          ),
        { concurrency: 1 }
      )
      const exchanges = yield* Effect.forEach(
        grantIds,
        (grantId) => grants.exchange(owner, grantId, "authorization-code"),
        { concurrency: "unbounded" }
      ).pipe(Effect.forkChild({ startImmediately: true }))

      yield* Deferred.await(allExchangesStarted)
      assert.strictEqual(yield* grants.pendingGrantCount, MAXIMUM_PENDING_GRANTS)
      const overflow = yield* grants.start(owner, "http://127.0.0.1:4173", ["jira"]).pipe(
        Effect.provideService(ConfigProvider.ConfigProvider, configProvider),
        Effect.result
      )
      assert.isTrue(Result.isFailure(overflow))

      yield* Deferred.succeed(releaseExchanges, undefined)
      assert.lengthOf(yield* Fiber.join(exchanges), MAXIMUM_PENDING_GRANTS)
      assert.strictEqual(yield* grants.pendingGrantCount, MAXIMUM_PENDING_GRANTS)
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))
})
