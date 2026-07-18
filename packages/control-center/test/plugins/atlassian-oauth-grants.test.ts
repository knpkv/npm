import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert, describe, it } from "@effect/vitest"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"

import { AtlassianOAuthGrantId } from "../../src/api/plugins.js"
import { SessionId, WorkspaceId } from "../../src/domain/identifiers.js"
import { makeAtlassianOAuthGrants } from "../../src/server/plugins/atlassian/AtlassianOAuthGrants.js"

const owner = {
  sessionId: SessionId.make("0198f6e1-4de2-7a20-8a64-576c88bd9784"),
  workspaceId: WorkspaceId.make("0198f6e1-4de2-7a20-8a64-576c88bd9785")
}

const providerClient = HttpClient.make((request) => {
  const body = request.url.endsWith("/oauth/token")
    ? {
      access_token: "access-secret",
      refresh_token: "refresh-secret",
      expires_in: 3_600,
      scope: "read:jira-work read:page:confluence offline_access",
      token_type: "Bearer"
    }
    : request.url.endsWith("/accessible-resources")
    ? [
      {
        id: "cloud-1",
        name: "Acme Europe",
        url: "https://acme.atlassian.net/",
        scopes: ["read:jira-work"]
      },
      {
        id: "cloud-2",
        name: "Acme Labs",
        url: "https://labs.atlassian.net/",
        scopes: ["read:jira-work"]
      }
    ]
    : { account_id: "account-1", name: "Avery Bell", email: "avery@example.com" }
  return Effect.succeed(
    HttpClientResponse.fromWeb(
      request,
      new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })
    )
  )
})

describe("AtlassianOAuthGrants", () => {
  it.effect("exchanges a session-bound grant, requires site choice, and saves one shared profile", () =>
    Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "control-center-atlassian-oauth-" })
      const configHome = path.join(home, "config")
      const jiraStore = path.join(configHome, "atlassian", "jira-cli")
      yield* fileSystem.makeDirectory(jiraStore, { recursive: true })
      yield* fileSystem.writeFileString(
        path.join(jiraStore, "oauth.json"),
        JSON.stringify({ clientId: "client-id", clientSecret: "client-secret" })
      )

      const configProvider = ConfigProvider.fromUnknown({ HOME: home, XDG_CONFIG_HOME: configHome })
      const grants = yield* makeAtlassianOAuthGrants()
      const started = yield* grants.start(owner, "http://127.0.0.1:4173").pipe(
        Effect.provideService(ConfigProvider.ConfigProvider, configProvider)
      )
      assert.strictEqual(started._tag, "ready")
      if (started._tag !== "ready") return
      assert.strictEqual(started.callbackUrl, "http://127.0.0.1:4173/services/oauth/atlassian/callback")
      const authorizationUrl = new URL(started.authorizationUrl)
      assert.strictEqual(authorizationUrl.searchParams.get("redirect_uri"), started.callbackUrl)
      const grantId = yield* Schema.decodeUnknownEffect(AtlassianOAuthGrantId)(
        authorizationUrl.searchParams.get("state")
      )

      const wrongOwner = { ...owner, sessionId: SessionId.make("0198f6e1-4de2-7a20-8a64-576c88bd9786") }
      const rejected = yield* Effect.result(
        grants.exchange(wrongOwner, grantId, "authorization-code").pipe(
          Effect.provideService(ConfigProvider.ConfigProvider, configProvider)
        )
      )
      assert.isTrue(Result.isFailure(rejected))

      const exchanged = yield* grants.exchange(owner, grantId, "authorization-code").pipe(
        Effect.provideService(ConfigProvider.ConfigProvider, configProvider)
      )
      assert.deepStrictEqual(exchanged.sites.map(({ cloudId }) => cloudId), ["cloud-1", "cloud-2"])
      assert.notInclude(JSON.stringify(exchanged), "secret")

      const confluenceStore = path.join(configHome, "atlassian", "confluence-to-markdown")
      yield* fileSystem.writeFileString(confluenceStore, "blocks-directory-creation")
      const failedSave = yield* Effect.result(
        grants.complete(owner, exchanged.grantId, "cloud-2").pipe(
          Effect.provideService(ConfigProvider.ConfigProvider, configProvider)
        )
      )
      assert.isTrue(Result.isFailure(failedSave))
      yield* fileSystem.remove(confluenceStore)

      const completed = yield* grants.complete(owner, exchanged.grantId, "cloud-2").pipe(
        Effect.provideService(ConfigProvider.ConfigProvider, configProvider)
      )
      assert.deepStrictEqual(completed.providers, ["jira", "confluence"])
      assert.strictEqual(completed.siteUrl, "https://labs.atlassian.net/")

      for (const storeName of ["jira-cli", "confluence-to-markdown"]) {
        const store = path.join(configHome, "atlassian", storeName)
        const profiles = yield* fileSystem.readFileString(path.join(store, "profiles.json"))
        assert.include(profiles, completed.profileId)
        assert.include(profiles, "access-secret")
        const oauth = yield* fileSystem.readFileString(path.join(store, "oauth.json"))
        assert.include(oauth, "client-secret")
      }

      const replay = yield* Effect.result(
        grants.complete(owner, exchanged.grantId, "cloud-2").pipe(
          Effect.provideService(ConfigProvider.ConfigProvider, configProvider)
        )
      )
      assert.isTrue(Result.isFailure(replay))
    }).pipe(
      Effect.provideService(HttpClient.HttpClient, providerClient),
      Effect.provide(NodeServices.layer),
      Effect.scoped
    ))
})
