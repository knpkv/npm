/**
 * OAuth2 authentication service for Confluence with shared Atlassian profiles.
 *
 * **Mental model**
 *
 * - OAuth endpoint work is delegated to `@knpkv/atlassian-common/auth`.
 * - Multi-account/site profile storage is delegated to `@knpkv/atlassian-common/config`.
 * - The public service keeps Confluence's plain-string access token return type.
 *
 * @module
 */
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import {
  buildAuthUrl,
  buildOAuthToken,
  computeCodeChallenge,
  CONFLUENCE_SCOPES,
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
  FileSystemError,
  type HomeDirectoryError,
  HomeDirectoryLive,
  HomeDirectoryTag,
  getProfilesPath,
  isTokenExpired,
  loadActiveProfile,
  loadActiveProfileToken,
  loadOAuthConfig,
  loadProfiles,
  type OAuthConfig,
  OAuthConfigSchema,
  type OAuthToken,
  OAuthTokenSchema,
  type OAuthUser,
  saveOAuthConfig,
  saveProfileToken,
  setActiveProfileBySelector
} from "@knpkv/atlassian-common/config"
import * as Console from "effect/Console"
import * as Context from "effect/Context"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Path from "effect/Path"
import type * as PlatformError from "effect/PlatformError"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"
import { HttpClient } from "effect/unstable/http"
import { ChildProcessSpawner } from "effect/unstable/process"
import { AuthMissingError } from "./ConfluenceError.js"
import { HttpServerFactoryLive } from "./internal/NodeLayers.js"
import { startCallbackServer } from "./internal/oauthServer.js"
import { openBrowser } from "./internal/openBrowser.js"

const TOOL_NAME = "confluence-to-markdown"
const LEGACY_DIR_NAME = ".confluence"

const TokenStorageLive = Layer.mergeAll(
  NodeFileSystem.layer,
  NodePath.layer,
  HomeDirectoryLive
)

const parseJsonOrNull = (content: string): unknown | null => {
  try {
    return JSON.parse(content) as unknown
  } catch {
    return null
  }
}

const getLegacyPath = (fileName: string) =>
  Effect.gen(function*() {
    const homeDirectory = yield* HomeDirectoryTag
    const path = yield* Path.Path
    const home = yield* homeDirectory.get()
    return path.join(home, LEGACY_DIR_NAME, fileName)
  })

const readLegacyJson = (
  fileName: string
): Effect.Effect<
  unknown | null,
  FileSystemError | HomeDirectoryError,
  FileSystem.FileSystem | Path.Path | HomeDirectoryTag
> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const filePath = yield* getLegacyPath(fileName)
    const exists = yield* fs.exists(filePath).pipe(
      Effect.catch(() => Effect.succeed(false))
    )
    if (!exists) return null

    const content = yield* fs.readFileString(filePath).pipe(
      Effect.mapError((cause) => new FileSystemError({ operation: "read", path: filePath, cause }))
    )

    const parsed = parseJsonOrNull(content)
    if (parsed === null) return null

    return parsed
  })

const loadLegacyToken = (): Effect.Effect<
  OAuthToken | null,
  FileSystemError | HomeDirectoryError,
  FileSystem.FileSystem | Path.Path | HomeDirectoryTag
> =>
  Effect.gen(function*() {
    const parsed = yield* readLegacyJson("auth.json")
    if (parsed === null) return null
    return yield* Schema.decodeUnknownEffect(OAuthTokenSchema)(parsed).pipe(
      Effect.catch(() => Effect.succeed(null))
    )
  })

const loadLegacyOAuthConfig = (): Effect.Effect<
  OAuthConfig | null,
  FileSystemError | HomeDirectoryError,
  FileSystem.FileSystem | Path.Path | HomeDirectoryTag
> =>
  Effect.gen(function*() {
    const parsed = yield* readLegacyJson("config.json")
    if (parsed === null) return null
    return yield* Schema.decodeUnknownEffect(OAuthConfigSchema)(parsed).pipe(
      Effect.catch(() => Effect.succeed(null))
    )
  })

const profilesStoreExists = (): Effect.Effect<
  boolean,
  HomeDirectoryError,
  FileSystem.FileSystem | Path.Path | HomeDirectoryTag
> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const profilesPath = yield* getProfilesPath(TOOL_NAME)
    return yield* fs.exists(profilesPath).pipe(
      Effect.catch(() => Effect.succeed(false))
    )
  })

const loadTokenOp = () =>
  Effect.gen(function*() {
    const token = yield* loadActiveProfileToken(TOOL_NAME)
    if (token !== null) return token
    const hasProfilesStore = yield* profilesStoreExists()
    if (hasProfilesStore) return null
    const legacyToken = yield* loadLegacyToken()
    if (legacyToken !== null) {
      yield* saveProfileToken(TOOL_NAME, legacyToken)
    }
    return legacyToken
  }).pipe(Effect.provide(TokenStorageLive))
const saveTokenOp = (token: OAuthToken) => saveProfileToken(TOOL_NAME, token).pipe(Effect.provide(TokenStorageLive))
const deleteTokenOp = () => deleteActiveProfile(TOOL_NAME).pipe(Effect.provide(TokenStorageLive))
const loadOAuthConfigOp = () =>
  Effect.gen(function*() {
    const config = yield* loadOAuthConfig(TOOL_NAME)
    if (config !== null) return config
    const legacyConfig = yield* loadLegacyOAuthConfig()
    if (legacyConfig !== null) {
      yield* saveOAuthConfig(TOOL_NAME, legacyConfig)
    }
    return legacyConfig
  }).pipe(Effect.provide(TokenStorageLive))
const saveOAuthConfigOp = (config: OAuthConfig) =>
  saveOAuthConfig(TOOL_NAME, config).pipe(Effect.provide(TokenStorageLive))
const loadActiveProfileOp = () => loadActiveProfile(TOOL_NAME).pipe(Effect.provide(TokenStorageLive))
const listProfilesOp = () =>
  loadProfiles(TOOL_NAME).pipe(Effect.map((store) => store.profiles), Effect.provide(TokenStorageLive))
const switchProfileOp = (selector: string) =>
  setActiveProfileBySelector(TOOL_NAME, selector).pipe(Effect.provide(TokenStorageLive))
const removeProfileOp = (selector: string) =>
  deleteProfileBySelector(TOOL_NAME, selector).pipe(Effect.provide(TokenStorageLive))

/**
 * Options for the login method.
 */
export interface LoginOptions {
  /** Site URL to select (for accounts with multiple sites) */
  readonly siteUrl?: string
}

/**
 * Information about an accessible Confluence site.
 */
export interface AccessibleSite {
  readonly id: string
  readonly name: string
  readonly url: string
}

/**
 * ConfluenceAuth service interface.
 *
 * @category Services
 */
export interface ConfluenceAuthService {
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
    string,
    AuthMissingError | OAuthError | FileSystemError | HomeDirectoryError | PlatformError.PlatformError
  >
  /** Get cloud ID from stored token */
  readonly getCloudId: () => Effect.Effect<
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
 * ConfluenceAuth service tag.
 *
 * @category Services
 */
export class ConfluenceAuth extends Context.Service<
  ConfluenceAuth,
  ConfluenceAuthService
>()("@knpkv/confluence-to-markdown/ConfluenceAuth") {}

const make = Effect.gen(function*() {
  const httpClient = yield* HttpClient.HttpClient
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner

  const refreshLock = yield* Ref.make<
    Option.Option<
      Deferred.Deferred<OAuthToken, OAuthError | FileSystemError | HomeDirectoryError | PlatformError.PlatformError>
    >
  >(
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
            cause: "OAuth not configured. Run 'confluence auth configure' first."
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

  const configure: ConfluenceAuthService["configure"] = (config) => saveOAuthConfigOp(config)

  const isConfigured: ConfluenceAuthService["isConfigured"] = () =>
    Effect.gen(function*() {
      const config = yield* loadOAuthConfigOp()
      return config !== null
    })

  const login: ConfluenceAuthService["login"] = (options) =>
    Effect.gen(function*() {
      const config = yield* getConfig()
      const state = yield* generateUUID()
      const codeVerifier = generateCodeVerifier()
      const codeChallenge = yield* computeCodeChallenge(codeVerifier)

      const { codePromise, port, shutdown } = yield* startCallbackServer(state).pipe(
        Effect.provide(HttpServerFactoryLive),
        Effect.mapError((cause) => new OAuthError({ step: "authorize", cause }))
      )
      const authUrl = buildAuthUrl({
        clientId: config.clientId,
        state,
        port,
        scopes: CONFLUENCE_SCOPES,
        codeChallenge
      })

      yield* Console.log(`Opening browser for Atlassian login (callback on port ${port})...`)
      yield* Console.log(`If browser doesn't open, visit: ${authUrl}`)
      yield* openBrowserImpl(authUrl)
      yield* Console.log("Waiting for authorization (press Ctrl+C to cancel)...")

      const code = yield* codePromise.pipe(
        Effect.mapError((cause) => new OAuthError({ step: "authorize", cause })),
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
            cause: "No Confluence sites found for this account"
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
          yield* Console.log("Multiple Confluence sites found. Please select one:")
          for (const s of sites) {
            yield* Console.log(`  - ${s.name}: ${s.url}`)
          }
          yield* Console.log("\nRun 'confluence auth login --site <url>' to select a site")
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

  const logout: ConfluenceAuthService["logout"] = () =>
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

  const getAccessToken: ConfluenceAuthService["getAccessToken"] = () =>
    Effect.gen(function*() {
      const token = yield* loadTokenOp()
      if (token === null) {
        return yield* Effect.fail(new AuthMissingError())
      }

      if (!isTokenExpired(token)) {
        return token.access_token
      }

      const deferred = yield* Deferred.make<
        OAuthToken,
        OAuthError | FileSystemError | HomeDirectoryError | PlatformError.PlatformError
      >()
      const existing = yield* Ref.modify(refreshLock, (current) =>
        Option.isSome(current)
          ? [current.value, current] as const
          : [deferred, Option.some(deferred)] as const)

      if (existing !== deferred) {
        const refreshed = yield* Deferred.await(existing)
        return refreshed.access_token
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
                  cause: "Refresh token expired. Please run 'confluence auth login' to re-authenticate."
                })
              )
            })
          }
          return Effect.fail(error)
        })
      )

      const exit = yield* refresh.pipe(
        Effect.exit,
        Effect.ensuring(Ref.set(refreshLock, Option.none()))
      )
      yield* Deferred.done(deferred, exit)
      const result = yield* Deferred.await(deferred)

      return result.access_token
    })

  const getCloudId: ConfluenceAuthService["getCloudId"] = () =>
    Effect.gen(function*() {
      const token = yield* loadTokenOp()
      if (token === null) {
        return yield* Effect.fail(new AuthMissingError())
      }
      return token.cloud_id
    })

  const getCurrentUser: ConfluenceAuthService["getCurrentUser"] = () =>
    Effect.gen(function*() {
      const token = yield* loadTokenOp()
      return token?.user ?? null
    })

  const getActiveProfile: ConfluenceAuthService["getActiveProfile"] = () => loadActiveProfileOp()

  const listProfiles: ConfluenceAuthService["listProfiles"] = () => listProfilesOp()

  const switchProfile: ConfluenceAuthService["switchProfile"] = (selector) => switchProfileOp(selector)

  const removeProfile: ConfluenceAuthService["removeProfile"] = (selector) => removeProfileOp(selector)

  const isLoggedIn: ConfluenceAuthService["isLoggedIn"] = () =>
    Effect.gen(function*() {
      const token = yield* loadTokenOp()
      return token !== null
    })

  return ConfluenceAuth.of({
    configure,
    isConfigured,
    login,
    logout,
    getAccessToken,
    getCloudId,
    getCurrentUser,
    getActiveProfile,
    listProfiles,
    switchProfile,
    removeProfile,
    isLoggedIn
  })
})

/**
 * Layer for ConfluenceAuth service.
 *
 * @category Layers
 */
export const layer: Layer.Layer<
  ConfluenceAuth,
  never,
  HttpClient.HttpClient | ChildProcessSpawner.ChildProcessSpawner
> = Layer.effect(ConfluenceAuth, make)
