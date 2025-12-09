/**
 * OAuth authentication service for Confluence.
 *
 * @module
 */
import * as HttpClient from "@effect/platform/HttpClient"
import * as HttpClientRequest from "@effect/platform/HttpClientRequest"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { exec } from "node:child_process"
import * as crypto from "node:crypto"
import type { FileSystemError } from "./ConfluenceError.js"
import { AuthMissingError, OAuthError } from "./ConfluenceError.js"
import { startCallbackServer } from "./internal/oauthServer.js"
import { deleteToken, loadOAuthConfig, loadToken, saveOAuthConfig, saveToken } from "./internal/tokenStorage.js"
import type { OAuthConfig, OAuthToken, OAuthUser } from "./Schemas.js"

const OAUTH_REDIRECT_URI = "http://localhost:8585/callback"
const OAUTH_SCOPES = [
  "read:page:confluence",
  "write:page:confluence",
  "read:me",
  "offline_access"
].join(" ")

// API endpoints
const AUTH_URL = "https://auth.atlassian.com/authorize"
const TOKEN_URL = "https://auth.atlassian.com/oauth/token"
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
 * ConfluenceAuth service interface.
 *
 * @category Services
 */
export interface ConfluenceAuthService {
  /** Configure OAuth client credentials */
  readonly configure: (config: OAuthConfig) => Effect.Effect<void, FileSystemError>
  /** Check if OAuth is configured */
  readonly isConfigured: () => Effect.Effect<boolean, FileSystemError>
  /** Start OAuth login flow */
  readonly login: () => Effect.Effect<void, OAuthError | FileSystemError>
  /** Remove stored authentication */
  readonly logout: () => Effect.Effect<void, FileSystemError>
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

const openBrowser = (url: string): Effect.Effect<void, OAuthError> =>
  Effect.async<void, OAuthError>((resume) => {
    const platform = process.platform
    const command = platform === "darwin" ? "open" : platform === "win32" ? "start" : "xdg-open"

    exec(`${command} "${url}"`, (error) => {
      if (error) {
        resume(Effect.fail(new OAuthError({ step: "authorize", cause: error })))
      } else {
        resume(Effect.succeed(undefined))
      }
    })
  })

const buildAuthUrl = (clientId: string, state: string): string => {
  const params = new URLSearchParams({
    audience: "api.atlassian.com",
    client_id: clientId,
    scope: OAUTH_SCOPES,
    redirect_uri: OAUTH_REDIRECT_URI,
    state,
    response_type: "code",
    prompt: "consent"
  })
  return `${AUTH_URL}?${params.toString()}`
}

const make = Effect.gen(function*() {
  const httpClient = yield* HttpClient.HttpClient

  const getConfig = (): Effect.Effect<OAuthConfig, OAuthError | FileSystemError> =>
    Effect.gen(function*() {
      const config = yield* loadOAuthConfig()
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
    config: OAuthConfig
  ): Effect.Effect<Schema.Schema.Type<typeof TokenResponseSchema>, OAuthError> =>
    Effect.gen(function*() {
      const request = yield* HttpClientRequest.post(TOKEN_URL).pipe(
        HttpClientRequest.setHeader("Content-Type", "application/json"),
        HttpClientRequest.bodyJson({
          grant_type: "authorization_code",
          client_id: config.clientId,
          client_secret: config.clientSecret,
          code,
          redirect_uri: OAUTH_REDIRECT_URI
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

      yield* saveToken(updated)
      return updated
    })

  const configure: ConfluenceAuthService["configure"] = (config) => saveOAuthConfig(config)

  const isConfigured: ConfluenceAuthService["isConfigured"] = () =>
    Effect.gen(function*() {
      const config = yield* loadOAuthConfig()
      return config !== null
    })

  const login: ConfluenceAuthService["login"] = () =>
    Effect.gen(function*() {
      const config = yield* getConfig()
      const state = crypto.randomUUID()
      const authUrl = buildAuthUrl(config.clientId, state)

      const { codePromise, shutdown } = yield* startCallbackServer(state)

      yield* Effect.log("Opening browser for Atlassian login...")
      yield* openBrowser(authUrl)
      yield* Effect.log("Waiting for authorization (press Ctrl+C to cancel)...")

      const code = yield* codePromise.pipe(
        Effect.timeout("5 minutes"),
        Effect.catchTag("TimeoutException", () =>
          Effect.fail(new OAuthError({ step: "authorize", cause: "Authorization timed out" })))
      )

      yield* shutdown

      yield* Effect.log("Exchanging code for tokens...")
      const tokens = yield* exchangeCodeForTokens(code, config)

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

      if (sites.length > 1) {
        const siteList = sites.map((s) =>
          `  - ${s.name}: ${s.url}`
        ).join("\n")
        return yield* Effect.fail(
          new OAuthError({
            step: "authorize",
            cause: `Multiple Confluence sites found. Use API token auth instead:\n${siteList}`
          })
        )
      }

      const site = sites[0]!

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

      yield* saveToken(tokenData)
      yield* Effect.log(`Logged in as ${user.name} (${user.email})`)
    })

  const logout: ConfluenceAuthService["logout"] = () =>
    Effect.gen(function*() {
      const token = yield* loadToken()
      if (token === null) {
        yield* Effect.log("Not logged in")
        return
      }
      yield* deleteToken()
    })

  const getAccessToken: ConfluenceAuthService["getAccessToken"] = () =>
    Effect.gen(function*() {
      const token = yield* loadToken()
      if (token === null) {
        return yield* Effect.fail(new AuthMissingError())
      }

      const now = Date.now()
      const buffer = 5 * 60 * 1000 // 5 minutes

      if (token.expires_at - buffer > now) {
        return token.access_token
      }

      const config = yield* getConfig()
      yield* Effect.log("Token expired, refreshing...")
      const refreshed = yield* refreshToken(token, config)
      return refreshed.access_token
    })

  const getCloudId: ConfluenceAuthService["getCloudId"] = () =>
    Effect.gen(function*() {
      const token = yield* loadToken()
      if (token === null) {
        return yield* Effect.fail(new AuthMissingError())
      }
      return token.cloud_id
    })

  const getCurrentUser: ConfluenceAuthService["getCurrentUser"] = () =>
    Effect.gen(function*() {
      const token = yield* loadToken()
      return token?.user ?? null
    })

  const isLoggedIn: ConfluenceAuthService["isLoggedIn"] = () =>
    Effect.gen(function*() {
      const token = yield* loadToken()
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
export const layer: Layer.Layer<ConfluenceAuth, never, HttpClient.HttpClient> = Layer.effect(
  ConfluenceAuth,
  make
)
