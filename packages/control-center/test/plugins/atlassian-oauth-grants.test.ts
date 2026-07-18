import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert, describe, it } from "@effect/vitest"
import { CONFLUENCE_SCOPES, JIRA_SCOPES } from "@knpkv/atlassian-common/auth"
import { HomeDirectoryLive, loadProfiles } from "@knpkv/atlassian-common/config"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as TestClock from "effect/testing/TestClock"
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
      scope: [...JIRA_SCOPES, ...CONFLUENCE_SCOPES].join(" "),
      token_type: "Bearer"
    }
    : request.url.endsWith("/accessible-resources")
    ? [
      {
        id: "cloud-1",
        name: "Acme Europe",
        url: "https://acme.atlassian.net/",
        scopes: [...JIRA_SCOPES]
      },
      {
        id: "cloud-2",
        name: "Acme Labs",
        url: "https://labs.atlassian.net/",
        scopes: [...JIRA_SCOPES, ...CONFLUENCE_SCOPES]
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

const makeConcurrentProviderClient = (): HttpClient.HttpClient => {
  let issuedTokens = 0
  return HttpClient.make((request) => {
    const identity = request.url.endsWith("/oauth/token")
      ? String(++issuedTokens)
      : request.headers.authorization?.endsWith("-2")
      ? "2"
      : "1"
    const body = request.url.endsWith("/oauth/token")
      ? {
        access_token: `access-${identity}`,
        refresh_token: `refresh-${identity}`,
        expires_in: 3_600,
        scope: [...JIRA_SCOPES, ...CONFLUENCE_SCOPES].join(" "),
        token_type: "Bearer"
      }
      : request.url.endsWith("/accessible-resources")
      ? [{
        id: `cloud-${identity}`,
        name: `Acme ${identity}`,
        url: `https://acme-${identity}.atlassian.net/`,
        scopes: [...JIRA_SCOPES, ...CONFLUENCE_SCOPES]
      }]
      : { account_id: `account-${identity}`, name: `Avery ${identity}`, email: `avery-${identity}@example.com` }
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })
      )
    )
  })
}

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
      assert.deepStrictEqual(exchanged.sites.map(({ cloudId }) => cloudId), ["cloud-2"])
      assert.notInclude(JSON.stringify(exchanged), "secret")

      const confluenceStore = path.join(configHome, "atlassian", "confluence-to-markdown")
      yield* fileSystem.writeFileString(confluenceStore, "blocks-directory-creation")
      const failedSave = yield* Effect.result(
        grants.complete(owner, exchanged.grantId, "cloud-2").pipe(
          Effect.provideService(ConfigProvider.ConfigProvider, configProvider)
        )
      )
      assert.isTrue(Result.isFailure(failedSave))
      assert.strictEqual(
        yield* fileSystem.readFileString(path.join(jiraStore, "oauth.json")),
        JSON.stringify({ clientId: "client-id", clientSecret: "client-secret" })
      )
      assert.isFalse(yield* fileSystem.exists(path.join(jiraStore, "profiles.json")))
      assert.isFalse(yield* fileSystem.exists(path.join(jiraStore, "auth.json")))
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

  it.effect("purges abandoned provider tokens when their grant expires", () =>
    Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "control-center-atlassian-expiry-" })
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
      const grantId = yield* Schema.decodeUnknownEffect(AtlassianOAuthGrantId)(
        new URL(started.authorizationUrl).searchParams.get("state")
      )
      yield* grants.exchange(owner, grantId, "authorization-code").pipe(
        Effect.provideService(ConfigProvider.ConfigProvider, configProvider)
      )
      assert.strictEqual(yield* grants.pendingGrantCount, 1)
      yield* TestClock.adjust("10 minutes")
      assert.strictEqual(yield* grants.pendingGrantCount, 0)
    }).pipe(
      Effect.provideService(HttpClient.HttpClient, providerClient),
      Effect.provide(NodeServices.layer),
      Effect.scoped
    ))

  it.effect("restores a grant when profile snapshots cannot be read", () =>
    Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "control-center-atlassian-snapshot-" })
      const configHome = path.join(home, "config")
      const jiraStore = path.join(configHome, "atlassian", "jira-cli")
      const profilesPath = path.join(jiraStore, "profiles.json")
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
      const grantId = yield* Schema.decodeUnknownEffect(AtlassianOAuthGrantId)(
        new URL(started.authorizationUrl).searchParams.get("state")
      )
      const exchanged = yield* grants.exchange(owner, grantId, "authorization-code").pipe(
        Effect.provideService(ConfigProvider.ConfigProvider, configProvider)
      )

      yield* fileSystem.makeDirectory(profilesPath)
      const failedSnapshot = yield* Effect.result(
        grants.complete(owner, exchanged.grantId, "cloud-2").pipe(
          Effect.provideService(ConfigProvider.ConfigProvider, configProvider)
        )
      )
      assert.isTrue(Result.isFailure(failedSnapshot))
      yield* fileSystem.remove(profilesPath, { recursive: true })

      const completed = yield* grants.complete(owner, exchanged.grantId, "cloud-2").pipe(
        Effect.provideService(ConfigProvider.ConfigProvider, configProvider)
      )
      assert.strictEqual(completed.cloudId, "cloud-2")
    }).pipe(
      Effect.provideService(HttpClient.HttpClient, providerClient),
      Effect.provide(NodeServices.layer),
      Effect.scoped
    ))

  it.effect("preserves both profiles when two grants complete concurrently", () =>
    Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "control-center-atlassian-concurrent-" })
      const configHome = path.join(home, "config")
      const jiraStore = path.join(configHome, "atlassian", "jira-cli")
      yield* fileSystem.makeDirectory(jiraStore, { recursive: true })
      yield* fileSystem.writeFileString(
        path.join(jiraStore, "oauth.json"),
        JSON.stringify({ clientId: "client-id", clientSecret: "client-secret" })
      )
      const configProvider = ConfigProvider.fromUnknown({ HOME: home, XDG_CONFIG_HOME: configHome })
      const grants = yield* makeAtlassianOAuthGrants()
      const prepareGrant = Effect.fn("test.prepareAtlassianOAuthGrant")(function*(authorizationCode: string) {
        const started = yield* grants.start(owner, "http://127.0.0.1:4173").pipe(
          Effect.provideService(ConfigProvider.ConfigProvider, configProvider)
        )
        assert.strictEqual(started._tag, "ready")
        if (started._tag !== "ready") return yield* Effect.die("OAuth grant did not start")
        const grantId = yield* Schema.decodeUnknownEffect(AtlassianOAuthGrantId)(
          new URL(started.authorizationUrl).searchParams.get("state")
        )
        return yield* grants.exchange(owner, grantId, authorizationCode).pipe(
          Effect.provideService(ConfigProvider.ConfigProvider, configProvider)
        )
      })
      const first = yield* prepareGrant("authorization-code-1")
      const second = yield* prepareGrant("authorization-code-2")

      yield* Effect.all([
        grants.complete(owner, first.grantId, "cloud-1"),
        grants.complete(owner, second.grantId, "cloud-2")
      ], { concurrency: "unbounded" }).pipe(
        Effect.provideService(ConfigProvider.ConfigProvider, configProvider)
      )

      for (const storeName of ["jira-cli", "confluence-to-markdown"]) {
        const profiles = yield* loadProfiles(storeName).pipe(
          Effect.provide(HomeDirectoryLive),
          Effect.provideService(ConfigProvider.ConfigProvider, configProvider)
        )
        assert.deepStrictEqual(
          profiles.profiles.map(({ token }) => token.user?.account_id ?? null).sort(),
          ["account-1", "account-2"]
        )
      }
    }).pipe(
      Effect.provideService(HttpClient.HttpClient, makeConcurrentProviderClient()),
      Effect.provide(NodeServices.layer),
      Effect.scoped
    ))
})
