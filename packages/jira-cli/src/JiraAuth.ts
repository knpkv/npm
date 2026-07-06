/**
 * OAuth2 authentication service for Jira CLI with token refresh and concurrency locking.
 *
 * **Mental model**
 *
 * - **Service pattern**: {@link JiraAuth} is a `Context.Tag` whose layer requires `HttpClient`
 *   and `ChildProcessSpawner`. All token storage operations are pre-bound to
 *   `@knpkv/atlassian-common/config` with a `"jira-cli"` tool name.
 * - **Refresh lock**: A `Ref<Option<Deferred>>` prevents concurrent token refreshes — the
 *   first caller refreshes, others await the same Deferred.
 * - **Browser-based login**: {@link JiraAuthService.login} starts a local callback server,
 *   opens the browser, and awaits the OAuth code with a 5-minute timeout.
 *
 * **Common tasks**
 *
 * - Get a valid access token: `auth.getAccessToken()` (auto-refreshes if expired)
 * - Full login flow: `auth.login()`
 * - Check auth state: `auth.isLoggedIn()`
 *
 * @module
 */
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import {
  buildAuthUrl,
  buildOAuthToken,
  computeCodeChallenge,
  exchangeCodeForTokens,
  generateCodeVerifier,
  generateUUID,
  getAccessibleResources,
  getUserInfo,
  OAuthError,
  refreshToken,
  revokeToken
} from "@knpkv/atlassian-common/auth"
import {
  type AuthProfile,
  deleteActiveProfile,
  deleteProfileBySelector,
  type FileSystemError,
  type HomeDirectoryError,
  HomeDirectoryLive,
  isTokenExpired,
  loadActiveProfile,
  loadActiveProfileToken,
  loadOAuthConfig,
  loadProfiles,
  type OAuthConfig,
  type OAuthToken,
  type OAuthUser,
  saveOAuthConfig,
  saveProfileToken,
  setActiveProfileBySelector
} from "@knpkv/atlassian-common/config"
import * as Console from "effect/Console"
import * as Context from "effect/Context"
import * as Crypto from "effect/Crypto"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import type * as PlatformError from "effect/PlatformError"
import * as Redacted from "effect/Redacted"
import * as Ref from "effect/Ref"
import * as HttpClient from "effect/unstable/http/HttpClient"
import { ChildProcessSpawner } from "effect/unstable/process"
import { HttpServerFactoryLive } from "./internal/NodeLayers.js"
import { startCallbackServer } from "./internal/oauthServer.js"
import { openBrowser } from "./internal/openBrowser.js"
import type { AuthMissingError } from "./JiraCliError.js"
import { authMissing } from "./JiraCliError.js"

/** OAuth scopes for the Jira CLI. Granular scopes must also be enabled on the app in the developer console. */
const JIRA_CLI_SCOPES = [
  // Read issues, search, and read versions.
  "read:jira-work",
  // Edit issues and write worklogs.
  "write:jira-work",
  // Edit a version (e.g. its description) via `PUT /rest/api/3/version/{id}` and
  // manage version "Related work" links (`/rest/api/3/version/{id}/relatedwork`).
  "manage:jira-project",
  // Resolve account IDs to display names for Driver/Contributors/Approvers.
  "read:jira-user",
  // Read the authenticated user's own profile (`/rest/api/3/myself`).
  "read:me",
  // Issue a refresh token so the CLI stays logged in across runs.
  "offline_access"
]

const TOOL_NAME = "jira-cli"

// Layer for token storage operations (FileSystem + Path + HomeDirectory)
const TokenStorageLive = Layer.mergeAll(
  NodeFileSystem.layer,
  NodePath.layer,
  HomeDirectoryLive
)

// Wrap token storage operations with their required layers
const loadTokenOp = () => loadActiveProfileToken(TOOL_NAME).pipe(Effect.provide(TokenStorageLive))
const saveTokenOp = (token: OAuthToken) => saveProfileToken(TOOL_NAME, token).pipe(Effect.provide(TokenStorageLive))
const deleteTokenOp = () => deleteActiveProfile(TOOL_NAME).pipe(Effect.provide(TokenStorageLive))
const listProfilesOp = () =>
  loadProfiles(TOOL_NAME).pipe(Effect.map((store) => store.profiles), Effect.provide(TokenStorageLive))
const loadActiveProfileOp = () => loadActiveProfile(TOOL_NAME).pipe(Effect.provide(TokenStorageLive))
const switchProfileOp = (selector: string) =>
  setActiveProfileBySelector(TOOL_NAME, selector).pipe(Effect.provide(TokenStorageLive))
const removeProfileOp = (selector: string) =>
  deleteProfileBySelector(TOOL_NAME, selector).pipe(Effect.provide(TokenStorageLive))
const loadOAuthConfigOp = () => loadOAuthConfig(TOOL_NAME).pipe(Effect.provide(TokenStorageLive))
const saveOAuthConfigOp = (config: OAuthConfig) =>
  saveOAuthConfig(TOOL_NAME, config).pipe(Effect.provide(TokenStorageLive))

/**
 * Options for the login method.
 *
 * @category Types
 */
export interface LoginOptions {
  /** Site URL to select (for accounts with multiple sites) */
  readonly siteUrl?: string
}

/**
 * Information about an accessible Jira site.
 *
 * @category Types
 */
export interface AccessibleSite {
  readonly id: string
  readonly name: string
  readonly url: string
}

/**
 * JiraAuth service interface.
 *
 * @category Services
 */
export interface JiraAuthService {
  /** Configure OAuth client credentials */
  readonly configure: (
    config: OAuthConfig
  ) => Effect.Effect<void, FileSystemError | HomeDirectoryError | PlatformError.PlatformError>
  /** Check if OAuth is configured */
  readonly isConfigured: () => Effect.Effect<
    boolean,
    FileSystemError | HomeDirectoryError | PlatformError.PlatformError
  >
  /** Start OAuth login flow. Returns list of sites if multiple are available. */
  readonly login: (
    options?: LoginOptions
  ) => Effect.Effect<
    ReadonlyArray<AccessibleSite> | void,
    OAuthError | FileSystemError | HomeDirectoryError | PlatformError.PlatformError
  >
  /** Remove stored authentication */
  readonly logout: () => Effect.Effect<
    void,
    OAuthError | FileSystemError | HomeDirectoryError | PlatformError.PlatformError
  >
  /** Get access token, refreshing if needed */
  readonly getAccessToken: () => Effect.Effect<
    Redacted.Redacted<string>,
    AuthMissingError | OAuthError | FileSystemError | HomeDirectoryError | PlatformError.PlatformError
  >
  /** Get cloud ID from stored token */
  readonly getCloudId: () => Effect.Effect<
    string,
    AuthMissingError | FileSystemError | HomeDirectoryError | PlatformError.PlatformError
  >
  /** Get site URL from stored token */
  readonly getSiteUrl: () => Effect.Effect<
    string,
    AuthMissingError | FileSystemError | HomeDirectoryError | PlatformError.PlatformError
  >
  /** Get current user info from stored token */
  readonly getCurrentUser: () => Effect.Effect<
    OAuthUser | null,
    FileSystemError | HomeDirectoryError | PlatformError.PlatformError
  >
  /** Get active auth profile */
  readonly getActiveProfile: () => Effect.Effect<
    AuthProfile | null,
    FileSystemError | HomeDirectoryError | PlatformError.PlatformError
  >
  /** List stored auth profiles */
  readonly listProfiles: () => Effect.Effect<
    ReadonlyArray<AuthProfile>,
    FileSystemError | HomeDirectoryError | PlatformError.PlatformError
  >
  /** Switch active profile by ID, name, site URL, cloud ID, or account ID */
  readonly switchProfile: (
    selector: string
  ) => Effect.Effect<AuthProfile | null, FileSystemError | HomeDirectoryError | PlatformError.PlatformError>
  /** Remove stored profile by ID, name, site URL, cloud ID, or account ID */
  readonly removeProfile: (
    selector: string
  ) => Effect.Effect<AuthProfile | null, FileSystemError | HomeDirectoryError | PlatformError.PlatformError>
  /** Check if user is logged in */
  readonly isLoggedIn: () => Effect.Effect<boolean, FileSystemError | HomeDirectoryError | PlatformError.PlatformError>
}

/**
 * JiraAuth service tag.
 *
 * @example
 * ```typescript
 * import { Effect } from "effect"
 * import { JiraAuth } from "@knpkv/jira-cli/JiraAuth"
 *
 * Effect.gen(function* () {
 *   const auth = yield* JiraAuth
 *   const isLoggedIn = yield* auth.isLoggedIn()
 *   if (!isLoggedIn) {
 *     yield* auth.login()
 *   }
 * })
 * ```
 *
 * @category Services
 */
export class JiraAuth extends Context.Service<
  JiraAuth,
  JiraAuthService
>()("@knpkv/jira-cli/JiraAuth") {}

type RefreshError = OAuthError | FileSystemError | HomeDirectoryError | PlatformError.PlatformError
type RefreshDeferred = Deferred.Deferred<OAuthToken, RefreshError>

const make = Effect.gen(function*() {
  const httpClient = yield* HttpClient.HttpClient
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const cryptoService = yield* Crypto.Crypto

  // Ref to track ongoing refresh operation to prevent concurrent refreshes
  const refreshLock = yield* Ref.make<Option.Option<RefreshDeferred>>(
    Option.none()
  )

  const openBrowserImpl = (url: string): Effect.Effect<void, OAuthError> =>
    openBrowser(url).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
      Effect.mapError((cause) => new OAuthError({ step: "authorize", cause }))
    )

  const getConfig = (): Effect.Effect<
    OAuthConfig,
    OAuthError | FileSystemError | HomeDirectoryError | PlatformError.PlatformError
  > =>
    Effect.gen(function*() {
      const config = yield* loadOAuthConfigOp()
      if (config === null) {
        return yield* Effect.fail(
          new OAuthError({
            step: "authorize",
            cause: "OAuth not configured. Run 'jira auth configure' first."
          })
        )
      }
      return config
    })

  const refreshTokenImpl = (
    token: OAuthToken,
    config: OAuthConfig
  ): Effect.Effect<OAuthToken, OAuthError | FileSystemError | HomeDirectoryError | PlatformError.PlatformError> =>
    Effect.gen(function*() {
      const updated = yield* refreshToken(token, config).pipe(
        Effect.provide(Layer.succeed(HttpClient.HttpClient, httpClient))
      )
      yield* saveTokenOp(updated)
      return updated
    })

  const revokeTokenImpl = (
    token: OAuthToken,
    config: OAuthConfig
  ): Effect.Effect<void, OAuthError> =>
    revokeToken(token, config).pipe(
      Effect.provide(Layer.succeed(HttpClient.HttpClient, httpClient))
    )

  const configure = (
    config: OAuthConfig
  ): Effect.Effect<void, FileSystemError | HomeDirectoryError | PlatformError.PlatformError> =>
    saveOAuthConfigOp(config)

  const isConfigured = (): Effect.Effect<boolean, FileSystemError | HomeDirectoryError | PlatformError.PlatformError> =>
    Effect.gen(function*() {
      const config = yield* loadOAuthConfigOp()
      return config !== null
    })

  const login = (
    options?: LoginOptions
  ): Effect.Effect<
    ReadonlyArray<AccessibleSite> | void,
    OAuthError | FileSystemError | HomeDirectoryError | PlatformError.PlatformError
  > =>
    Effect.gen(function*() {
      const config = yield* getConfig()
      const state = yield* generateUUID().pipe(Effect.provideService(Crypto.Crypto, cryptoService))
      const codeVerifier = yield* generateCodeVerifier().pipe(Effect.provideService(Crypto.Crypto, cryptoService))
      const codeChallenge = yield* computeCodeChallenge(codeVerifier).pipe(
        Effect.provideService(Crypto.Crypto, cryptoService)
      )

      const { codePromise, port, shutdown } = yield* startCallbackServer(state).pipe(
        Effect.provide(HttpServerFactoryLive)
      )
      const authUrl = buildAuthUrl({ clientId: config.clientId, state, port, scopes: JIRA_CLI_SCOPES, codeChallenge })

      yield* Console.log(`Opening browser for Atlassian login (callback on port ${port})...`)
      yield* Console.log(`If browser doesn't open, visit: ${authUrl}`)
      yield* openBrowserImpl(authUrl)
      yield* Console.log("Waiting for authorization (press Ctrl+C to cancel)...")

      const code = yield* codePromise.pipe(
        Effect.timeout("5 minutes"),
        Effect.catchTag(
          "TimeoutError",
          () => Effect.fail(new OAuthError({ step: "authorize", cause: "Authorization timed out" }))
        ),
        Effect.ensuring(shutdown)
      )

      yield* Console.log("Exchanging code for tokens...")
      const tokens = yield* exchangeCodeForTokens(code, config, { port, codeVerifier }).pipe(
        Effect.provide(Layer.succeed(HttpClient.HttpClient, httpClient))
      )

      yield* Console.log("Fetching accessible sites...")
      const sites = yield* getAccessibleResources(tokens.access_token).pipe(
        Effect.provide(Layer.succeed(HttpClient.HttpClient, httpClient))
      )

      if (sites.length === 0) {
        return yield* Effect.fail(
          new OAuthError({
            step: "authorize",
            cause: "No Jira sites found for this account"
          })
        )
      }

      let site: (typeof sites)[number]

      if (sites.length > 1) {
        if (options?.siteUrl) {
          const matched = sites.find((s) => s.url === options.siteUrl)
          if (!matched) {
            const available = sites.map((s) => `  - ${s.name}: ${s.url}`).join("\n")
            return yield* Effect.fail(
              new OAuthError({
                step: "authorize",
                cause: `Site '${options.siteUrl}' not found. Available sites:\n${available}`
              })
            )
          }
          site = matched
        } else {
          yield* Console.log("Multiple Jira sites found. Please select one:")
          for (const s of sites) {
            yield* Console.log(`  - ${s.name}: ${s.url}`)
          }
          yield* Console.log("\nRun 'jira auth login --site <url>' to select a site")
          return sites.map((s) => ({ id: s.id, name: s.name, url: s.url }))
        }
      } else {
        site = sites[0]!
      }

      yield* Console.log("Fetching user info...")
      const user = yield* getUserInfo(tokens.access_token).pipe(
        Effect.provide(Layer.succeed(HttpClient.HttpClient, httpClient))
      )

      const tokenData = buildOAuthToken(tokens, site, user)

      yield* saveTokenOp(tokenData)
      yield* Console.log(`Logged in as ${user.name} (${user.email})`)
      return undefined
    })

  const logout = (): Effect.Effect<
    void,
    OAuthError | FileSystemError | HomeDirectoryError | PlatformError.PlatformError
  > =>
    Effect.gen(function*() {
      const token = yield* loadTokenOp()
      if (token === null) {
        yield* Console.log("Not logged in")
        return
      }

      const config = yield* loadOAuthConfigOp()
      if (config !== null) {
        yield* revokeTokenImpl(token, config).pipe(
          Effect.tap(() => Effect.log("Token revoked with Atlassian")),
          Effect.catch((error) => Effect.log(`Warning: Failed to revoke token: ${error.message}`))
        )
      }

      yield* deleteTokenOp()
    })

  const getAccessToken = (): Effect.Effect<
    Redacted.Redacted<string>,
    AuthMissingError | OAuthError | FileSystemError | HomeDirectoryError | PlatformError.PlatformError
  > =>
    Effect.gen(function*() {
      const token = yield* loadTokenOp()
      if (token === null) {
        return yield* Effect.fail(authMissing())
      }

      if (!isTokenExpired(token)) {
        return Redacted.make(token.access_token)
      }

      // Atomically check-then-set refresh lock to avoid TOCTOU race
      const deferred = yield* Deferred.make<OAuthToken, RefreshError>()
      const existing = yield* Ref.modify(refreshLock, (current) =>
        Option.isSome(current)
          ? ([current.value, current] satisfies readonly [RefreshDeferred, Option.Option<RefreshDeferred>])
          : ([deferred, Option.some(deferred)] satisfies readonly [RefreshDeferred, Option.Option<RefreshDeferred>]))

      // Another fiber is already refreshing — just await its result
      if (existing !== deferred) {
        const refreshed = yield* Deferred.await(existing)
        return Redacted.make(refreshed.access_token)
      }

      const refresh = Effect.gen(function*() {
        const config = yield* getConfig()
        yield* Console.log("Token expired, refreshing...")
        return yield* refreshTokenImpl(token, config)
      }).pipe(
        Effect.catchTag("OAuthError", (error) => {
          if (error.step === "refresh") {
            return Effect.gen(function*() {
              yield* deleteTokenOp()
              return yield* Effect.fail(
                new OAuthError({
                  step: "refresh",
                  cause: "Refresh token expired. Please run 'jira auth login' to re-authenticate."
                })
              )
            })
          }
          return Effect.fail(error)
        })
      )

      // This fiber owns the refresh. Complete the shared Deferred with the final
      // transformed exit so waiters observe the same success or failure.
      const exit = yield* refresh.pipe(
        Effect.exit,
        Effect.ensuring(Ref.set(refreshLock, Option.none()))
      )
      yield* Deferred.done(deferred, exit)
      const result = yield* Deferred.await(deferred)

      return Redacted.make(result.access_token)
    })

  const getCloudId = (): Effect.Effect<
    string,
    AuthMissingError | FileSystemError | HomeDirectoryError | PlatformError.PlatformError
  > =>
    Effect.gen(function*() {
      const token = yield* loadTokenOp()
      if (token === null) {
        return yield* Effect.fail(authMissing())
      }
      return token.cloud_id
    })

  const getSiteUrl = (): Effect.Effect<
    string,
    AuthMissingError | FileSystemError | HomeDirectoryError | PlatformError.PlatformError
  > =>
    Effect.gen(function*() {
      const token = yield* loadTokenOp()
      if (token === null) {
        return yield* Effect.fail(authMissing())
      }
      return token.site_url
    })

  const getCurrentUser = (): Effect.Effect<
    OAuthUser | null,
    FileSystemError | HomeDirectoryError | PlatformError.PlatformError
  > =>
    Effect.gen(function*() {
      const token = yield* loadTokenOp()
      return token?.user ?? null
    })

  const getActiveProfile = (): Effect.Effect<
    AuthProfile | null,
    FileSystemError | HomeDirectoryError | PlatformError.PlatformError
  > => loadActiveProfileOp()

  const listProfiles = (): Effect.Effect<
    ReadonlyArray<AuthProfile>,
    FileSystemError | HomeDirectoryError | PlatformError.PlatformError
  > => listProfilesOp()

  const switchProfile = (
    selector: string
  ): Effect.Effect<AuthProfile | null, FileSystemError | HomeDirectoryError | PlatformError.PlatformError> =>
    switchProfileOp(selector)

  const removeProfile = (
    selector: string
  ): Effect.Effect<AuthProfile | null, FileSystemError | HomeDirectoryError | PlatformError.PlatformError> =>
    removeProfileOp(selector)

  const isLoggedIn = (): Effect.Effect<boolean, FileSystemError | HomeDirectoryError | PlatformError.PlatformError> =>
    Effect.gen(function*() {
      const token = yield* loadTokenOp()
      return token !== null
    })

  return JiraAuth.of({
    configure,
    isConfigured,
    login,
    logout,
    getAccessToken,
    getCloudId,
    getSiteUrl,
    getCurrentUser,
    getActiveProfile,
    listProfiles,
    switchProfile,
    removeProfile,
    isLoggedIn
  })
})

/**
 * Layer for JiraAuth service.
 *
 * @category Layers
 */
export const layer = Layer.effect(JiraAuth, make)
