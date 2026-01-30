/**
 * Core OAuth2 operations for Atlassian APIs.
 *
 * @module
 */
import * as HttpClient from "@effect/platform/HttpClient"
import * as HttpClientRequest from "@effect/platform/HttpClientRequest"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
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
 * Exchange authorization code for tokens.
 *
 * @param code - Authorization code from OAuth callback
 * @param config - OAuth client configuration
 * @param port - Local callback server port (for redirect_uri)
 *
 * @category Operations
 */
export const exchangeCodeForTokens = (
  code: string,
  config: OAuthConfig,
  port: number
): Effect.Effect<TokenResponse, OAuthError, HttpClient.HttpClient> =>
  Effect.gen(function*() {
    const httpClient = yield* HttpClient.HttpClient
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
    const body = yield* response.json

    return yield* Schema.decodeUnknown(Schema.Array(AccessibleResourceSchema))(body)
  }).pipe(
    Effect.mapError((cause) => new OAuthError({ step: "authorize", cause }))
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
    const body = yield* response.json

    return yield* Schema.decodeUnknown(UserInfoSchema)(body)
  }).pipe(
    Effect.mapError((cause) => new OAuthError({ step: "authorize", cause }))
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
    const body = yield* response.json.pipe(
      Effect.mapError((cause) => new OAuthError({ step: "refresh", cause }))
    )
    const tokenResponse = yield* Schema.decodeUnknown(TokenResponseSchema)(body).pipe(
      Effect.mapError((cause) => new OAuthError({ step: "refresh", cause }))
    )

    return {
      ...token,
      access_token: tokenResponse.access_token,
      refresh_token: tokenResponse.refresh_token,
      expires_at: Date.now() + tokenResponse.expires_in * 1000,
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
