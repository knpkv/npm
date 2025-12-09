/**
 * OAuth authentication service for Confluence.
 *
 * @module
 */
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import * as Command from "@effect/platform/Command"
import * as CommandExecutor from "@effect/platform/CommandExecutor"
import * as HttpClient from "@effect/platform/HttpClient"
import * as HttpClientRequest from "@effect/platform/HttpClientRequest"
import * as Context from "effect/Context"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"
import type { FileSystemError } from "./ConfluenceError.js"
import { AuthMissingError, OAuthError } from "./ConfluenceError.js"
import { HttpServerFactoryLive } from "./internal/NodeLayers.js"
import { startCallbackServer } from "./internal/oauthServer.js"
import {
  deleteToken,
  HomeDirectoryLive,
  loadOAuthConfig,
  loadToken,
  saveOAuthConfig,
  saveToken
} from "./internal/tokenStorage.js"
import type { OAuthConfig, OAuthToken, OAuthUser } from "./Schemas.js"

// Layer for token storage operations (FileSystem + Path + HomeDirectory)
const TokenStorageLive = Layer.mergeAll(
  NodeFileSystem.layer,
  NodePath.layer,
  HomeDirectoryLive
)

/**
 * Generate a cryptographically secure UUID v4.
 * Uses Web Crypto API (available in all modern runtimes).
 * Format: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
 */
const generateUUID = (): Effect.Effect<string> =>
  Effect.sync(() => {
    const bytes = new Uint8Array(16)
    globalThis.crypto.getRandomValues(bytes)

    // Set version (4) and variant bits per RFC 4122
    bytes[6] = (bytes[6]! & 0x0f) | 0x40 // version 4
    bytes[8] = (bytes[8]! & 0x3f) | 0x80 // variant 10xx

    const hex = Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")

    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
  })

const OAUTH_SCOPES = [
  "read:page:confluence",
  "write:page:confluence",
  "read:me",
  "offline_access"
].join(" ")

// API endpoints
const AUTH_URL = "https://auth.atlassian.com/authorize"
const TOKEN_URL = "https://auth.atlassian.com/oauth/token"
const REVOKE_URL = "https://auth.atlassian.com/oauth/revoke"
const RESOURCES_URL = "https://api.atlassian.com/oauth/token/accessible-resources"
const ME_URL = "https://api.atlassian.com/me"

// Response schemas
const TokenResponseSchema = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.String,
  expires_in: Schema.Number,
  scope: Schema.String,
  token_type: Schema.String
})

const AccessibleResourceSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  url: Schema.String,
  scopes: Schema.Array(Schema.String)
})

const UserInfoSchema = Schema.Struct({
  account_id: Schema.String,
  name: Schema.String,
  email: Schema.String
})

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
  readonly configure: (config: OAuthConfig) => Effect.Effect<void, FileSystemError>
  /** Check if OAuth is configured */
  readonly isConfigured: () => Effect.Effect<boolean, FileSystemError>
  /** Start OAuth login flow. Returns list of sites if multiple are available. */
  readonly login: (
    options?: LoginOptions
  ) => Effect.Effect<ReadonlyArray<AccessibleSite> | void, OAuthError | FileSystemError>
  /** Remove stored authentication */
  readonly logout: () => Effect.Effect<void, OAuthError | FileSystemError>
  /** Get access token, refreshing if needed */
  readonly getAccessToken: () => Effect.Effect<string, AuthMissingError | OAuthError | FileSystemError>
  /** Get cloud ID from stored token */
  readonly getCloudId: () => Effect.Effect<string, AuthMissingError | FileSystemError>
  /** Get current user info from stored token */
  readonly getCurrentUser: () => Effect.Effect<OAuthUser | null, FileSystemError>
  /** Check if user is logged in */
  readonly isLoggedIn: () => Effect.Effect<boolean, FileSystemError>
}

/**
 * ConfluenceAuth service tag.
 *
 * @example
 * ```typescript
 * import { Effect } from "effect"
 * import { ConfluenceAuth } from "@knpkv/confluence-to-markdown/ConfluenceAuth"
 *
 * Effect.gen(function* () {
 *   const auth = yield* ConfluenceAuth
 *   const isLoggedIn = yield* auth.isLoggedIn()
 *   if (!isLoggedIn) {
 *     yield* auth.login()
 *   }
 * })
 * ```
 *
 * @category Services
 */
export class ConfluenceAuth extends Context.Tag("@knpkv/confluence-to-markdown/ConfluenceAuth")<
  ConfluenceAuth,
  ConfluenceAuthService
>() {}

const buildAuthUrl = (clientId: string, state: string, port: number): string => {
  const params = new URLSearchParams({
    audience: "api.atlassian.com",
    client_id: clientId,
    scope: OAUTH_SCOPES,
    redirect_uri: `http://localhost:${port}/callback`,
    state,
    response_type: "code",
    prompt: "consent"
  })
  return `${AUTH_URL}?${params.toString()}`
}

// Wrap token storage operations with their required layers
const loadTokenOp = () => loadToken().pipe(Effect.provide(TokenStorageLive))
const saveTokenOp = (token: OAuthToken) => saveToken(token).pipe(Effect.provide(TokenStorageLive))
const deleteTokenOp = () => deleteToken().pipe(Effect.provide(TokenStorageLive))
const loadOAuthConfigOp = () => loadOAuthConfig().pipe(Effect.provide(TokenStorageLive))
const saveOAuthConfigOp = (config: OAuthConfig) => saveOAuthConfig(config).pipe(Effect.provide(TokenStorageLive))

const make = Effect.gen(function*() {
  const httpClient = yield* HttpClient.HttpClient
  const commandExecutor = yield* CommandExecutor.CommandExecutor

  // Ref to track ongoing refresh operation to prevent concurrent refreshes
  const refreshLock = yield* Ref.make<Option.Option<Deferred.Deferred<OAuthToken, OAuthError | FileSystemError>>>(
    Option.none()
  )

  const openBrowserImpl = (url: string): Effect.Effect<void, OAuthError> =>
    Effect.gen(function*() {
      const platform = process.platform
      let command: Command.Command

      if (platform === "darwin") {
        command = Command.make("open", url)
      } else if (platform === "win32") {
        command = Command.make("cmd", "/c", "start", "", url)
      } else {
        command = Command.make("xdg-open", url)
      }

      yield* Command.exitCode(command).pipe(
        Effect.provide(Layer.succeed(CommandExecutor.CommandExecutor, commandExecutor))
      )
    }).pipe(
      Effect.mapError((cause) => new OAuthError({ step: "authorize", cause }))
    )

  const getConfig = (): Effect.Effect<OAuthConfig, OAuthError | FileSystemError> =>
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

  const exchangeCodeForTokens = (
    code: string,
    config: OAuthConfig,
    port: number
  ): Effect.Effect<Schema.Schema.Type<typeof TokenResponseSchema>, OAuthError> =>
    Effect.gen(function*() {
      const request = yield* HttpClientRequest.post(TOKEN_URL).pipe(
        HttpClientRequest.setHeader("Content-Type", "application/json"),
        HttpClientRequest.bodyJson({
          grant_type: "authorization_code",
          client_id: config.clientId,
          client_secret: config.clientSecret,
          code,
          redirect_uri: `http://localhost:${port}/callback`
        })
      )

      const response = yield* httpClient.execute(request)
      const body = yield* response.json

      return yield* Schema.decodeUnknown(TokenResponseSchema)(body)
    }).pipe(
      Effect.mapError((cause) => new OAuthError({ step: "token", cause }))
    )

  const getAccessibleResources = (
    accessToken: string
  ): Effect.Effect<ReadonlyArray<Schema.Schema.Type<typeof AccessibleResourceSchema>>, OAuthError> =>
    Effect.gen(function*() {
      const request = HttpClientRequest.get(RESOURCES_URL).pipe(
        HttpClientRequest.setHeader("Authorization", `Bearer ${accessToken}`),
        HttpClientRequest.setHeader("Accept", "application/json")
      )

      const response = yield* httpClient.execute(request)
      const body = yield* response.json

      return yield* Schema.decodeUnknown(Schema.Array(AccessibleResourceSchema))(body)
    }).pipe(
      Effect.mapError((cause) => new OAuthError({ step: "authorize", cause }))
    )

  const getUserInfo = (
    accessToken: string
  ): Effect.Effect<OAuthUser, OAuthError> =>
    Effect.gen(function*() {
      const request = HttpClientRequest.get(ME_URL).pipe(
        HttpClientRequest.setHeader("Authorization", `Bearer ${accessToken}`),
        HttpClientRequest.setHeader("Accept", "application/json")
      )

      const response = yield* httpClient.execute(request)
      const body = yield* response.json

      return yield* Schema.decodeUnknown(UserInfoSchema)(body)
    }).pipe(
      Effect.mapError((cause) => new OAuthError({ step: "authorize", cause }))
    )

  const refreshToken = (
    token: OAuthToken,
    config: OAuthConfig
  ): Effect.Effect<OAuthToken, OAuthError | FileSystemError> =>
    Effect.gen(function*() {
      const request = yield* HttpClientRequest.post(TOKEN_URL).pipe(
        HttpClientRequest.setHeader("Content-Type", "application/json"),
        HttpClientRequest.bodyJson({
          grant_type: "refresh_token",
          client_id: config.clientId,
          client_secret: config.clientSecret,
          refresh_token: token.refresh_token
        }),
        Effect.mapError((cause) => new OAuthError({ step: "refresh", cause }))
      )

      const response = yield* httpClient.execute(request).pipe(
        Effect.mapError((cause) => new OAuthError({ step: "refresh", cause }))
      )
      const body = yield* response.json.pipe(
        Effect.mapError((cause) => new OAuthError({ step: "refresh", cause }))
      )
      const tokenResponse = yield* Schema.decodeUnknown(TokenResponseSchema)(body).pipe(
        Effect.mapError((cause) => new OAuthError({ step: "refresh", cause }))
      )

      const updated: OAuthToken = {
        ...token,
        access_token: tokenResponse.access_token,
        refresh_token: tokenResponse.refresh_token,
        expires_at: Date.now() + tokenResponse.expires_in * 1000,
        scope: tokenResponse.scope
      }

      yield* saveTokenOp(updated)
      return updated
    })

  const revokeToken = (
    token: OAuthToken,
    config: OAuthConfig
  ): Effect.Effect<void, OAuthError> =>
    Effect.gen(function*() {
      // Revoke refresh token (this also invalidates access token)
      const request = yield* HttpClientRequest.post(REVOKE_URL).pipe(
        HttpClientRequest.setHeader("Content-Type", "application/json"),
        HttpClientRequest.bodyJson({
          client_id: config.clientId,
          client_secret: config.clientSecret,
          token: token.refresh_token
        }),
        Effect.mapError((cause) => new OAuthError({ step: "revoke", cause }))
      )

      const response = yield* httpClient.execute(request).pipe(
        Effect.mapError((cause) => new OAuthError({ step: "revoke", cause }))
      )

      // Validate response status
      if (response.status >= 400) {
        return yield* Effect.fail(
          new OAuthError({
            step: "revoke",
            cause: `Token revocation failed with status ${response.status}`
          })
        )
      }
    })

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

      const { codePromise, port, shutdown } = yield* startCallbackServer(state).pipe(
        Effect.provide(HttpServerFactoryLive)
      )
      const authUrl = buildAuthUrl(config.clientId, state, port)

      yield* Effect.log(`Opening browser for Atlassian login (callback on port ${port})...`)
      yield* openBrowserImpl(authUrl)
      yield* Effect.log("Waiting for authorization (press Ctrl+C to cancel)...")

      const code = yield* codePromise.pipe(
        Effect.timeout("5 minutes"),
        Effect.catchTag("TimeoutException", () =>
          Effect.fail(new OAuthError({ step: "authorize", cause: "Authorization timed out" })))
      )

      yield* shutdown

      yield* Effect.log("Exchanging code for tokens...")
      const tokens = yield* exchangeCodeForTokens(code, config, port)

      yield* Effect.log("Fetching accessible sites...")
      const sites = yield* getAccessibleResources(tokens.access_token)

      if (sites.length === 0) {
        return yield* Effect.fail(
          new OAuthError({
            step: "authorize",
            cause: "No Confluence sites found for this account"
          })
        )
      }

      let site: Schema.Schema.Type<typeof AccessibleResourceSchema>

      if (sites.length > 1) {
        // If siteUrl provided, try to match it
        if (options?.siteUrl) {
          const matched = sites.find((s) =>
            s.url === options.siteUrl
          )
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
          // Return sites list for user to choose
          yield* Effect.log("Multiple Confluence sites found. Please select one:")
          for (const s of sites) {
            yield* Effect.log(`  - ${s.name}: ${s.url}`)
          }
          yield* Effect.log("\nRun 'confluence auth login --site <url>' to select a site")
          return sites.map((s) => ({ id: s.id, name: s.name, url: s.url }))
        }
      } else {
        site = sites[0]!
      }

      yield* Effect.log("Fetching user info...")
      const user = yield* getUserInfo(tokens.access_token)

      const tokenData: OAuthToken = {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_at: Date.now() + tokens.expires_in * 1000,
        scope: tokens.scope,
        cloud_id: site.id,
        site_url: site.url,
        user: {
          account_id: user.account_id,
          name: user.name,
          email: user.email
        }
      }

      yield* saveTokenOp(tokenData)
      yield* Effect.log(`Logged in as ${user.name} (${user.email})`)
      return undefined
    })

  const logout: ConfluenceAuthService["logout"] = () =>
    Effect.gen(function*() {
      const token = yield* loadTokenOp()
      if (token === null) {
        yield* Effect.log("Not logged in")
        return
      }

      // Try to revoke the token with Atlassian (best effort)
      const config = yield* loadOAuthConfigOp()
      if (config !== null) {
        yield* revokeToken(token, config).pipe(
          Effect.tap(() => Effect.log("Token revoked with Atlassian")),
          Effect.catchAll((error) => Effect.log(`Warning: Failed to revoke token: ${error.message}`))
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

      const now = Date.now()
      const buffer = 5 * 60 * 1000 // 5 minutes

      if (token.expires_at - buffer > now) {
        return token.access_token
      }

      // Check if refresh is already in progress
      const existing = yield* Ref.get(refreshLock)
      if (Option.isSome(existing)) {
        // Wait for existing refresh to complete
        const refreshed = yield* Deferred.await(existing.value)
        return refreshed.access_token
      }

      // Start new refresh operation
      const deferred = yield* Deferred.make<OAuthToken, OAuthError | FileSystemError>()
      yield* Ref.set(refreshLock, Option.some(deferred))

      const config = yield* getConfig()
      yield* Effect.log("Token expired, refreshing...")

      const result = yield* refreshToken(token, config).pipe(
        Effect.tap((refreshed) => Deferred.succeed(deferred, refreshed)),
        Effect.tapError((error) => Deferred.fail(deferred, error)),
        Effect.ensuring(Ref.set(refreshLock, Option.none())),
        Effect.catchTag("OAuthError", (error) => {
          // If refresh fails (e.g., refresh token expired), clear tokens and prompt re-login
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
  HttpClient.HttpClient | CommandExecutor.CommandExecutor
> = Layer.effect(ConfluenceAuth, make)
