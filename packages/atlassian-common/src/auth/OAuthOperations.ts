/**
 * Core OAuth2 operations against Atlassian's token and resource endpoints.
 *
 * **Mental model**
 *
 * - **Effect-native HTTP**: Every operation takes an `HttpClient` from the Effect
 *   context and returns `Effect<A, OAuthError, HttpClient>`. Callers provide the
 *   client via `Layer.succeed`.
 * - **Schema-validated responses**: Token and user payloads are decoded through
 *   Effect Schema before returning, catching API contract drift at runtime.
 *
 * **Common tasks**
 *
 * - Exchange auth code: {@link exchangeCodeForTokens}
 * - List user sites: {@link getAccessibleResources}
 * - Refresh expired token: {@link refreshToken}
 * - Build storable token: {@link buildOAuthToken}
 *
 * @module
 */
import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { type OAuthConfig, type OAuthToken } from "../config/OAuthSchemas.js"
import { ME_URL, RESOURCES_URL, REVOKE_URL, TOKEN_URL } from "./OAuthEndpoints.js"
import { OAuthError } from "./OAuthErrors.js"
import {
  type AccessibleResource,
  AccessibleResourceSchema,
  type TokenResponse,
  TokenResponseSchema,
  type UserInfo,
  UserInfoSchema
} from "./OAuthResponseSchemas.js"

/**
 * Options for exchanging an authorization code for tokens.
 *
 * @category Types
 */
export interface ExchangeCodeOptions {
  /** Local callback server port (for redirect_uri) */
  readonly port: number
  /** Exact callback URL used by the authorization request. */
  readonly redirectUri?: string | undefined
  /** PKCE code verifier (if PKCE was used in auth request) */
  readonly codeVerifier?: string | undefined
}

/**
 * Exchange authorization code for tokens.
 *
 * @category Operations
 */
export const exchangeCodeForTokens = (
  code: string,
  config: OAuthConfig,
  options: ExchangeCodeOptions
): Effect.Effect<TokenResponse, OAuthError, HttpClient.HttpClient> =>
  Effect.gen(function*() {
    const httpClient = yield* HttpClient.HttpClient
    const tokenBody: Record<string, string> = {
      grant_type: "authorization_code",
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      redirect_uri: options.redirectUri ?? `http://localhost:${options.port}/callback`
    }
    if (options.codeVerifier) tokenBody.code_verifier = options.codeVerifier
    const request = yield* HttpClientRequest.post(TOKEN_URL).pipe(
      HttpClientRequest.setHeader("Content-Type", "application/json"),
      HttpClientRequest.bodyJson(tokenBody)
    )

    const response = yield* httpClient.execute(request)

    if (response.status >= 400) {
      const text = yield* response.text
      yield* Effect.logDebug(`Token exchange failed (${response.status}): ${text}`)
      return yield* Effect.fail(
        new OAuthError({ step: "token", cause: `HTTP ${response.status}` })
      )
    }

    const body = yield* response.json

    return yield* Schema.decodeUnknownEffect(TokenResponseSchema)(body)
  }).pipe(
    Effect.mapError((cause) => new OAuthError({ step: "token", cause }))
  )

/**
 * Get accessible resources (sites) for the authenticated user.
 *
 * @param accessToken - OAuth access token
 *
 * @category Operations
 */
export const getAccessibleResources = (
  accessToken: string
): Effect.Effect<ReadonlyArray<AccessibleResource>, OAuthError, HttpClient.HttpClient> =>
  Effect.gen(function*() {
    const httpClient = yield* HttpClient.HttpClient
    const request = HttpClientRequest.get(RESOURCES_URL).pipe(
      HttpClientRequest.setHeader("Authorization", `Bearer ${accessToken}`),
      HttpClientRequest.setHeader("Accept", "application/json")
    )

    const response = yield* httpClient.execute(request)

    if (response.status >= 400) {
      const text = yield* response.text
      yield* Effect.logDebug(`Accessible resources failed (${response.status}): ${text}`)
      return yield* Effect.fail(
        new OAuthError({ step: "resources", cause: `HTTP ${response.status}` })
      )
    }

    const body = yield* response.json

    return yield* Schema.decodeUnknownEffect(Schema.Array(AccessibleResourceSchema))(body)
  }).pipe(
    Effect.mapError((cause) => new OAuthError({ step: "resources", cause }))
  )

/**
 * Get user info from /me endpoint.
 *
 * @param accessToken - OAuth access token
 *
 * @category Operations
 */
export const getUserInfo = (
  accessToken: string
): Effect.Effect<UserInfo, OAuthError, HttpClient.HttpClient> =>
  Effect.gen(function*() {
    const httpClient = yield* HttpClient.HttpClient
    const request = HttpClientRequest.get(ME_URL).pipe(
      HttpClientRequest.setHeader("Authorization", `Bearer ${accessToken}`),
      HttpClientRequest.setHeader("Accept", "application/json")
    )

    const response = yield* httpClient.execute(request)

    if (response.status >= 400) {
      const text = yield* response.text
      yield* Effect.logDebug(`User info failed (${response.status}): ${text}`)
      return yield* Effect.fail(
        new OAuthError({ step: "user-info", cause: `HTTP ${response.status}` })
      )
    }

    const body = yield* response.json

    return yield* Schema.decodeUnknownEffect(UserInfoSchema)(body)
  }).pipe(
    Effect.mapError((cause) => new OAuthError({ step: "user-info", cause }))
  )

/**
 * Refresh an expired OAuth token.
 *
 * @param token - Current OAuth token (with refresh_token)
 * @param config - OAuth client configuration
 *
 * @category Operations
 */
export const refreshToken = (
  token: OAuthToken,
  config: OAuthConfig
): Effect.Effect<OAuthToken, OAuthError, HttpClient.HttpClient> =>
  Effect.gen(function*() {
    const httpClient = yield* HttpClient.HttpClient
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

    if (response.status >= 400) {
      const text = yield* response.text.pipe(
        Effect.mapError((cause) => new OAuthError({ step: "refresh", cause }))
      )
      return yield* Effect.fail(
        new OAuthError({ step: "refresh", cause: `HTTP ${response.status}: ${text}` })
      )
    }

    const body = yield* response.json.pipe(
      Effect.mapError((cause) => new OAuthError({ step: "refresh", cause }))
    )
    const tokenResponse = yield* Schema.decodeUnknownEffect(TokenResponseSchema)(body).pipe(
      Effect.mapError((cause) => new OAuthError({ step: "refresh", cause }))
    )
    const nowMs = yield* Clock.currentTimeMillis

    return {
      ...token,
      access_token: tokenResponse.access_token,
      refresh_token: tokenResponse.refresh_token,
      expires_at: nowMs + tokenResponse.expires_in * 1000,
      scope: tokenResponse.scope
    }
  })

/**
 * Revoke an OAuth token.
 *
 * @param token - OAuth token to revoke
 * @param config - OAuth client configuration
 *
 * @category Operations
 */
export const revokeToken = (
  token: OAuthToken,
  config: OAuthConfig
): Effect.Effect<void, OAuthError, HttpClient.HttpClient> =>
  Effect.gen(function*() {
    const httpClient = yield* HttpClient.HttpClient
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

    if (response.status >= 400) {
      return yield* Effect.fail(
        new OAuthError({
          step: "revoke",
          cause: `Token revocation failed with status ${response.status}`
        })
      )
    }
  })

/**
 * Build OAuthToken from token response and site info.
 *
 * @param tokenResponse - Token response from exchange
 * @param site - Selected accessible resource
 * @param user - User info
 *
 * @category Utilities
 */
export const buildOAuthToken = (
  tokenResponse: TokenResponse,
  site: AccessibleResource,
  user: UserInfo
): OAuthToken => ({
  access_token: tokenResponse.access_token,
  refresh_token: tokenResponse.refresh_token,
  expires_at: Date.now() + tokenResponse.expires_in * 1000,
  scope: tokenResponse.scope,
  cloud_id: site.id,
  site_url: site.url,
  user: {
    account_id: user.account_id,
    name: user.name,
    email: user.email
  }
})
