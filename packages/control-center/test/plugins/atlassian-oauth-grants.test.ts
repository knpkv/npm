import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert, describe, it } from "@effect/vitest"
import { CONFLUENCE_SCOPES, JIRA_SCOPES, type UserInfo } from "@knpkv/atlassian-common/auth"
import { HomeDirectoryLive, loadProfiles, type OAuthToken, saveProfileToken } from "@knpkv/atlassian-common/config"
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

const SHARED_OAUTH_CONFIG = { clientId: "client-id", clientSecret: "client-secret" }
const CONTROL_CENTER_AUTH_STORE_NAME = "control-center"

const writeOAuthConfig = Effect.fn("test.writeAtlassianOAuthConfig")(function*(
  configHome: string,
  storeName: string,
  config = SHARED_OAUTH_CONFIG
) {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const store = path.join(configHome, "atlassian", storeName)
  yield* fileSystem.makeDirectory(store, { recursive: true })
  yield* fileSystem.writeFileString(path.join(store, "oauth.json"), JSON.stringify(config))
  return store
})

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

const makeUserMetadataProviderClient = (user: UserInfo): HttpClient.HttpClient =>
  HttpClient.make((request) => {
    if (!request.url.endsWith("/me")) return providerClient.execute(request)
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(JSON.stringify(user), { status: 200, headers: { "content-type": "application/json" } })
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

const makeProductScopedProviderClient = (
  cloudId: string,
  tokenScopes: ReadonlyArray<string>
): HttpClient.HttpClient =>
  HttpClient.make((request) => {
    const body = request.url.endsWith("/oauth/token")
      ? {
        access_token: `access-${cloudId}`,
        refresh_token: `refresh-${cloudId}`,
        expires_in: 3_600,
        scope: tokenScopes.join(" "),
        token_type: "Bearer"
      }
      : request.url.endsWith("/accessible-resources")
      ? [{
        id: cloudId,
        name: `Acme ${cloudId}`,
        url: `https://${cloudId}.atlassian.net/`,
        scopes: tokenScopes
      }]
      : { account_id: "account-1", name: "Avery Bell", email: "avery@example.com" }
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })
      )
    )
  })

describe("AtlassianOAuthGrants", () => {
  it.effect("requires the same shared OAuth app in both destination stores", () =>
    Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem
      const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "control-center-atlassian-config-" })
      const path = yield* Path.Path
      const configHome = path.join(home, "config")
      yield* writeOAuthConfig(configHome, "jira-cli")
      const configProvider = ConfigProvider.fromUnknown({ HOME: home, XDG_CONFIG_HOME: configHome })
      const grants = yield* makeAtlassianOAuthGrants()

      const started = yield* grants.start(owner, "http://127.0.0.1:4173", ["jira", "confluence"]).pipe(
        Effect.provideService(ConfigProvider.ConfigProvider, configProvider)
      )

      assert.deepStrictEqual(started, {
        _tag: "configuration-required",
        callbackUrl: "http://127.0.0.1:4173/services/oauth/atlassian/callback"
      })

      yield* writeOAuthConfig(configHome, "confluence-to-markdown", {
        clientId: "other-client-id",
        clientSecret: "other-client-secret"
      })
      const mismatched = yield* grants.start(owner, "http://127.0.0.1:4173", ["jira", "confluence"]).pipe(
        Effect.provideService(ConfigProvider.ConfigProvider, configProvider)
      )
      assert.strictEqual(mismatched._tag, "configuration-required")

      yield* writeOAuthConfig(configHome, "confluence-to-markdown")
      const ready = yield* grants.start(owner, "http://127.0.0.1:4173", ["jira", "confluence"]).pipe(
        Effect.provideService(ConfigProvider.ConfigProvider, configProvider)
      )
      assert.strictEqual(ready._tag, "ready")
      if (ready._tag !== "ready") return
      const requestedScopes = new URL(ready.authorizationUrl).searchParams.get("scope")?.split(" ").sort()
      assert.deepStrictEqual(requestedScopes, Array.from(new Set([...JIRA_SCOPES, ...CONFLUENCE_SCOPES])).sort())
    }).pipe(
      Effect.provideService(HttpClient.HttpClient, providerClient),
      Effect.provide(NodeServices.layer),
      Effect.scoped
    ))

  it.effect("carries provider intent through authorization, site filtering, and completion", () =>
    Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "control-center-atlassian-intent-" })
      const configHome = path.join(home, "config")
      yield* writeOAuthConfig(configHome, "jira-cli")
      yield* writeOAuthConfig(configHome, "confluence-to-markdown")
      const configProvider = ConfigProvider.fromUnknown({ HOME: home, XDG_CONFIG_HOME: configHome })
      const grants = yield* makeAtlassianOAuthGrants()

      const started = yield* grants.start(owner, "http://127.0.0.1:4173", ["jira"]).pipe(
        Effect.provideService(ConfigProvider.ConfigProvider, configProvider)
      )
      assert.strictEqual(started._tag, "ready")
      if (started._tag !== "ready") return
      assert.deepStrictEqual(
        new URL(started.authorizationUrl).searchParams.get("scope")?.split(" ").sort(),
        [...JIRA_SCOPES].sort()
      )
      const grantId = yield* Schema.decodeUnknownEffect(AtlassianOAuthGrantId)(
        new URL(started.authorizationUrl).searchParams.get("state")
      )
      const exchanged = yield* grants.exchange(owner, grantId, "authorization-code").pipe(
        Effect.provideService(ConfigProvider.ConfigProvider, configProvider)
      )
      assert.deepStrictEqual(exchanged.sites.map(({ cloudId }) => cloudId), ["cloud-1", "cloud-2"])

      const completed = yield* grants.complete(owner, exchanged.grantId, "cloud-1").pipe(
        Effect.provideService(ConfigProvider.ConfigProvider, configProvider)
      )
      assert.deepStrictEqual(completed.providers, ["jira"])
    }).pipe(
      Effect.provideService(HttpClient.HttpClient, providerClient),
      Effect.provide(NodeServices.layer),
      Effect.scoped
    ))

  it.effect("rejects overlong provider user metadata without retaining site selection", () =>
    Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "control-center-atlassian-user-metadata-" })
      const configHome = path.join(home, "config")
      yield* writeOAuthConfig(configHome, "jira-cli")
      yield* writeOAuthConfig(configHome, "confluence-to-markdown")
      const configProvider = ConfigProvider.fromUnknown({ HOME: home, XDG_CONFIG_HOME: configHome })
      const grants = yield* makeAtlassianOAuthGrants()
      const started = yield* grants.start(owner, "http://127.0.0.1:4173", ["jira", "confluence"]).pipe(
        Effect.provideService(ConfigProvider.ConfigProvider, configProvider)
      )
      assert.strictEqual(started._tag, "ready")
      if (started._tag !== "ready") return
      const grantId = yield* Schema.decodeUnknownEffect(AtlassianOAuthGrantId)(
        new URL(started.authorizationUrl).searchParams.get("state")
      )

      const exchanged = yield* Effect.result(grants.exchange(owner, grantId, "authorization-code"))

      assert.isTrue(Result.isFailure(exchanged))
      if (Result.isFailure(exchanged)) assert.strictEqual(exchanged.failure._tag, "ApplicationServiceUnavailable")
      assert.strictEqual(yield* grants.pendingGrantCount, 0)
    }).pipe(
      Effect.provideService(
        HttpClient.HttpClient,
        makeUserMetadataProviderClient({
          account_id: "account-1",
          name: "A".repeat(501),
          email: "avery@example.com"
        })
      ),
      Effect.provide(NodeServices.layer),
      Effect.scoped
    ))

  it.effect("exchanges a session-bound grant and saves one canonical profile for both providers", () =>
    Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "control-center-atlassian-oauth-" })
      const configHome = path.join(home, "config")
      const jiraStore = yield* writeOAuthConfig(configHome, "jira-cli")
      const confluenceStore = yield* writeOAuthConfig(configHome, "confluence-to-markdown")
      const canonicalStore = path.join(configHome, "atlassian", CONTROL_CENTER_AUTH_STORE_NAME)

      const configProvider = ConfigProvider.fromUnknown({ HOME: home, XDG_CONFIG_HOME: configHome })
      const grants = yield* makeAtlassianOAuthGrants()
      const started = yield* grants.start(owner, "http://127.0.0.1:4173", ["jira", "confluence"]).pipe(
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

      yield* fileSystem.writeFileString(canonicalStore, "blocks-directory-creation")
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
      for (const store of [jiraStore, confluenceStore]) {
        assert.isFalse(yield* fileSystem.exists(path.join(store, "profiles.json")))
        assert.isFalse(yield* fileSystem.exists(path.join(store, "auth.json")))
      }
      yield* fileSystem.remove(canonicalStore)

      const completed = yield* grants.complete(owner, exchanged.grantId, "cloud-2").pipe(
        Effect.provideService(ConfigProvider.ConfigProvider, configProvider)
      )
      assert.deepStrictEqual(completed.providers, ["jira", "confluence"])
      assert.strictEqual(completed.siteUrl, "https://labs.atlassian.net/")
      assert.strictEqual(
        yield* fileSystem.readFileString(path.join(jiraStore, "oauth.json")),
        JSON.stringify(SHARED_OAUTH_CONFIG)
      )

      const canonicalProfiles = yield* loadProfiles(CONTROL_CENTER_AUTH_STORE_NAME).pipe(
        Effect.provide(HomeDirectoryLive),
        Effect.provideService(ConfigProvider.ConfigProvider, configProvider)
      )
      assert.lengthOf(canonicalProfiles.profiles, 1)
      assert.strictEqual(canonicalProfiles.profiles[0]?.id, completed.profileId)
      assert.strictEqual(canonicalProfiles.profiles[0]?.token.refresh_token, "refresh-secret")
      assert.include(yield* fileSystem.readFileString(path.join(canonicalStore, "oauth.json")), "client-secret")

      for (const store of [jiraStore, confluenceStore]) {
        assert.isFalse(yield* fileSystem.exists(path.join(store, "profiles.json")))
        assert.isFalse(yield* fileSystem.exists(path.join(store, "auth.json")))
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
      yield* writeOAuthConfig(configHome, "jira-cli")
      yield* writeOAuthConfig(configHome, "confluence-to-markdown")
      const configProvider = ConfigProvider.fromUnknown({ HOME: home, XDG_CONFIG_HOME: configHome })
      const grants = yield* makeAtlassianOAuthGrants()
      const started = yield* grants.start(owner, "http://127.0.0.1:4173", ["jira", "confluence"]).pipe(
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

  it.effect("expires site selection ten minutes after authorization started", () =>
    Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "control-center-atlassian-absolute-expiry-" })
      const configHome = path.join(home, "config")
      yield* writeOAuthConfig(configHome, "jira-cli")
      yield* writeOAuthConfig(configHome, "confluence-to-markdown")
      const configProvider = ConfigProvider.fromUnknown({ HOME: home, XDG_CONFIG_HOME: configHome })
      const grants = yield* makeAtlassianOAuthGrants()
      const started = yield* grants.start(owner, "http://127.0.0.1:4173", ["jira", "confluence"]).pipe(
        Effect.provideService(ConfigProvider.ConfigProvider, configProvider)
      )
      assert.strictEqual(started._tag, "ready")
      if (started._tag !== "ready") return
      const grantId = yield* Schema.decodeUnknownEffect(AtlassianOAuthGrantId)(
        new URL(started.authorizationUrl).searchParams.get("state")
      )

      yield* TestClock.adjust("9 minutes")
      const exchanged = yield* grants.exchange(owner, grantId, "authorization-code").pipe(
        Effect.provideService(ConfigProvider.ConfigProvider, configProvider)
      )
      assert.strictEqual(yield* grants.pendingGrantCount, 1)

      yield* TestClock.adjust("1 minute")
      assert.strictEqual(yield* grants.pendingGrantCount, 0)
      const expired = yield* Effect.result(
        grants.complete(owner, exchanged.grantId, "cloud-2").pipe(
          Effect.provideService(ConfigProvider.ConfigProvider, configProvider)
        )
      )
      assert.isTrue(Result.isFailure(expired))
      if (Result.isFailure(expired)) assert.strictEqual(expired.failure._tag, "ApplicationResourceNotFound")
    }).pipe(
      Effect.provideService(HttpClient.HttpClient, providerClient),
      Effect.provide(NodeServices.layer),
      Effect.scoped
    ))

  it.effect("anchors token expiry to exchange time across delayed completion retry", () =>
    Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "control-center-atlassian-token-expiry-" })
      const configHome = path.join(home, "config")
      yield* writeOAuthConfig(configHome, "jira-cli")
      yield* writeOAuthConfig(configHome, "confluence-to-markdown")
      const canonicalStore = path.join(configHome, "atlassian", CONTROL_CENTER_AUTH_STORE_NAME)
      const configProvider = ConfigProvider.fromUnknown({ HOME: home, XDG_CONFIG_HOME: configHome })
      yield* TestClock.setTime(1_000_000)
      const grants = yield* makeAtlassianOAuthGrants()
      const started = yield* grants.start(owner, "http://127.0.0.1:4173", ["jira", "confluence"]).pipe(
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

      yield* TestClock.adjust("2 minutes")
      yield* fileSystem.writeFileString(canonicalStore, "blocks-directory-creation")
      const failedSave = yield* Effect.result(
        grants.complete(owner, exchanged.grantId, "cloud-2").pipe(
          Effect.provideService(ConfigProvider.ConfigProvider, configProvider)
        )
      )
      assert.isTrue(Result.isFailure(failedSave))

      yield* TestClock.adjust("2 minutes")
      yield* fileSystem.remove(canonicalStore)
      yield* grants.complete(owner, exchanged.grantId, "cloud-2").pipe(
        Effect.provideService(ConfigProvider.ConfigProvider, configProvider)
      )
      const profiles = yield* loadProfiles(CONTROL_CENTER_AUTH_STORE_NAME).pipe(
        Effect.provide(HomeDirectoryLive),
        Effect.provideService(ConfigProvider.ConfigProvider, configProvider)
      )
      assert.strictEqual(profiles.profiles[0]?.token.expires_at, 4_600_000)
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
      yield* writeOAuthConfig(configHome, "jira-cli")
      yield* writeOAuthConfig(configHome, "confluence-to-markdown")
      const profilesPath = path.join(configHome, "atlassian", CONTROL_CENTER_AUTH_STORE_NAME, "profiles.json")
      const configProvider = ConfigProvider.fromUnknown({ HOME: home, XDG_CONFIG_HOME: configHome })
      const grants = yield* makeAtlassianOAuthGrants()
      const started = yield* grants.start(owner, "http://127.0.0.1:4173", ["jira", "confluence"]).pipe(
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

      yield* fileSystem.makeDirectory(profilesPath, { recursive: true })
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
      yield* writeOAuthConfig(configHome, "jira-cli")
      yield* writeOAuthConfig(configHome, "confluence-to-markdown")
      const configProvider = ConfigProvider.fromUnknown({ HOME: home, XDG_CONFIG_HOME: configHome })
      const grants = yield* makeAtlassianOAuthGrants()
      const prepareGrant = Effect.fn("test.prepareAtlassianOAuthGrant")(function*(authorizationCode: string) {
        const started = yield* grants.start(owner, "http://127.0.0.1:4173", ["jira", "confluence"]).pipe(
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

      const profiles = yield* loadProfiles(CONTROL_CENTER_AUTH_STORE_NAME).pipe(
        Effect.provide(HomeDirectoryLive),
        Effect.provideService(ConfigProvider.ConfigProvider, configProvider)
      )
      assert.deepStrictEqual(
        profiles.profiles.map(({ token }) => token.user?.account_id ?? null).sort(),
        ["account-1", "account-2"]
      )
    }).pipe(
      Effect.provideService(HttpClient.HttpClient, makeConcurrentProviderClient()),
      Effect.provide(NodeServices.layer),
      Effect.scoped
    ))

  it.effect("prevents a product-scoped grant from replacing another product token for the same profile", () =>
    Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "control-center-atlassian-product-scope-" })
      const configHome = path.join(home, "config")
      yield* writeOAuthConfig(configHome, "jira-cli")
      yield* writeOAuthConfig(configHome, "confluence-to-markdown")
      yield* writeOAuthConfig(configHome, CONTROL_CENTER_AUTH_STORE_NAME)
      const configProvider = ConfigProvider.fromUnknown({ HOME: home, XDG_CONFIG_HOME: configHome })
      const jiraToken: OAuthToken = {
        access_token: "jira-access",
        refresh_token: "jira-refresh",
        expires_at: 4_102_444_800_000,
        scope: JIRA_SCOPES.join(" "),
        cloud_id: "cloud-1",
        site_url: "https://cloud-1.atlassian.net/",
        user: { account_id: "account-1", name: "Avery Bell", email: "avery@example.com" }
      }
      const jiraProfile = yield* saveProfileToken(CONTROL_CENTER_AUTH_STORE_NAME, jiraToken).pipe(
        Effect.provide(HomeDirectoryLive),
        Effect.provideService(ConfigProvider.ConfigProvider, configProvider)
      )
      const grants = yield* makeAtlassianOAuthGrants()
      const started = yield* grants.start(owner, "http://127.0.0.1:4173", ["confluence"]).pipe(
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

      const rejected = yield* Effect.result(
        grants.complete(owner, exchanged.grantId, "cloud-1").pipe(
          Effect.provideService(ConfigProvider.ConfigProvider, configProvider)
        )
      )
      assert.isTrue(Result.isFailure(rejected))

      const profiles = yield* loadProfiles(CONTROL_CENTER_AUTH_STORE_NAME).pipe(
        Effect.provide(HomeDirectoryLive),
        Effect.provideService(ConfigProvider.ConfigProvider, configProvider)
      )
      assert.lengthOf(profiles.profiles, 1)
      assert.strictEqual(profiles.profiles[0]?.id, jiraProfile.id)
      assert.deepStrictEqual(profiles.profiles[0]?.token, jiraToken)
    }).pipe(
      Effect.provideService(HttpClient.HttpClient, makeProductScopedProviderClient("cloud-1", CONFLUENCE_SCOPES)),
      Effect.provide(NodeServices.layer),
      Effect.scoped
    ))

  it.effect("saves a product-scoped grant for the same account on a different cloud", () =>
    Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "control-center-atlassian-product-cloud-" })
      const configHome = path.join(home, "config")
      yield* writeOAuthConfig(configHome, "jira-cli")
      yield* writeOAuthConfig(configHome, "confluence-to-markdown")
      yield* writeOAuthConfig(configHome, CONTROL_CENTER_AUTH_STORE_NAME)
      const configProvider = ConfigProvider.fromUnknown({ HOME: home, XDG_CONFIG_HOME: configHome })
      const jiraToken: OAuthToken = {
        access_token: "jira-access",
        refresh_token: "jira-refresh",
        expires_at: 4_102_444_800_000,
        scope: JIRA_SCOPES.join(" "),
        cloud_id: "cloud-1",
        site_url: "https://cloud-1.atlassian.net/",
        user: { account_id: "account-1", name: "Avery Bell", email: "avery@example.com" }
      }
      const jiraProfile = yield* saveProfileToken(CONTROL_CENTER_AUTH_STORE_NAME, jiraToken).pipe(
        Effect.provide(HomeDirectoryLive),
        Effect.provideService(ConfigProvider.ConfigProvider, configProvider)
      )
      const grants = yield* makeAtlassianOAuthGrants()
      const started = yield* grants.start(owner, "http://127.0.0.1:4173", ["confluence"]).pipe(
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
      const completed = yield* grants.complete(owner, exchanged.grantId, "cloud-2").pipe(
        Effect.provideService(ConfigProvider.ConfigProvider, configProvider)
      )

      const profiles = yield* loadProfiles(CONTROL_CENTER_AUTH_STORE_NAME).pipe(
        Effect.provide(HomeDirectoryLive),
        Effect.provideService(ConfigProvider.ConfigProvider, configProvider)
      )
      assert.lengthOf(profiles.profiles, 2)
      assert.include(profiles.profiles.map(({ id }) => id), jiraProfile.id)
      assert.include(profiles.profiles.map(({ id }) => id), completed.profileId)
      assert.deepStrictEqual(profiles.profiles.find(({ id }) => id === jiraProfile.id)?.token, jiraToken)
    }).pipe(
      Effect.provideService(HttpClient.HttpClient, makeProductScopedProviderClient("cloud-2", CONFLUENCE_SCOPES)),
      Effect.provide(NodeServices.layer),
      Effect.scoped
    ))

  it.effect("preserves an incompatible populated destination and restores the grant", () =>
    Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "control-center-atlassian-conflict-" })
      const configHome = path.join(home, "config")
      yield* writeOAuthConfig(configHome, "jira-cli")
      yield* writeOAuthConfig(configHome, "confluence-to-markdown")
      const canonicalStore = yield* writeOAuthConfig(configHome, CONTROL_CENTER_AUTH_STORE_NAME)
      const configProvider = ConfigProvider.fromUnknown({ HOME: home, XDG_CONFIG_HOME: configHome })
      const grants = yield* makeAtlassianOAuthGrants()
      const started = yield* grants.start(owner, "http://127.0.0.1:4173", ["jira", "confluence"]).pipe(
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

      const incompatibleConfig = { clientId: "other-client-id", clientSecret: "other-client-secret" }
      yield* writeOAuthConfig(configHome, CONTROL_CENTER_AUTH_STORE_NAME, incompatibleConfig)
      const existingToken: OAuthToken = {
        access_token: "existing-access",
        refresh_token: "existing-refresh",
        expires_at: 4_102_444_800_000,
        scope: CONFLUENCE_SCOPES.join(" "),
        cloud_id: "existing-cloud",
        site_url: "https://existing.atlassian.net/",
        user: { account_id: "existing-account", name: "Existing User", email: "existing@example.com" }
      }
      yield* saveProfileToken(CONTROL_CENTER_AUTH_STORE_NAME, existingToken).pipe(
        Effect.provide(HomeDirectoryLive),
        Effect.provideService(ConfigProvider.ConfigProvider, configProvider)
      )
      const before = yield* Effect.all([
        fileSystem.readFileString(path.join(canonicalStore, "oauth.json")),
        fileSystem.readFileString(path.join(canonicalStore, "profiles.json")),
        fileSystem.readFileString(path.join(canonicalStore, "auth.json"))
      ])

      const rejected = yield* Effect.result(
        grants.complete(owner, exchanged.grantId, "cloud-2").pipe(
          Effect.provideService(ConfigProvider.ConfigProvider, configProvider)
        )
      )
      assert.isTrue(Result.isFailure(rejected))
      const after = yield* Effect.all([
        fileSystem.readFileString(path.join(canonicalStore, "oauth.json")),
        fileSystem.readFileString(path.join(canonicalStore, "profiles.json")),
        fileSystem.readFileString(path.join(canonicalStore, "auth.json"))
      ])
      assert.deepStrictEqual(after, before)

      yield* fileSystem.remove(path.join(canonicalStore, "profiles.json"))
      yield* fileSystem.remove(path.join(canonicalStore, "auth.json"))
      const completed = yield* grants.complete(owner, exchanged.grantId, "cloud-2").pipe(
        Effect.provideService(ConfigProvider.ConfigProvider, configProvider)
      )
      assert.strictEqual(completed.cloudId, "cloud-2")
      assert.deepStrictEqual(
        JSON.parse(yield* fileSystem.readFileString(path.join(canonicalStore, "oauth.json"))),
        SHARED_OAUTH_CONFIG
      )
      assert.include(yield* fileSystem.readFileString(path.join(canonicalStore, "profiles.json")), completed.profileId)
    }).pipe(
      Effect.provideService(HttpClient.HttpClient, providerClient),
      Effect.provide(NodeServices.layer),
      Effect.scoped
    ))
})
