/**
 * Atlassian OAuth2 endpoint URLs, scope constants, authorization URL builder, and PKCE.
 *
 * **Mental model**
 *
 * - **Constants + builder**: Endpoint URLs are plain strings; {@link buildAuthUrl}
 *   assembles the full authorization URL with audience, scopes, CSRF state, and PKCE.
 * - **Scope sets**: {@link CONFLUENCE_SCOPES} and {@link JIRA_SCOPES} define the
 *   minimum permissions for each product's OAuth flow.
 * - **PKCE**: {@link generateCodeVerifier} and {@link computeCodeChallenge} implement
 *   RFC 7636 S256 to protect the authorization code grant from interception.
 *
 * @module
 */
import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Encoding from "effect/Encoding"
import type * as PlatformError from "effect/PlatformError"

/**
 * OAuth2 authorization endpoint.
 *
 * @category Endpoints
 */
export const AUTH_URL = "https://auth.atlassian.com/authorize"

/**
 * OAuth2 token endpoint.
 *
 * @category Endpoints
 */
export const TOKEN_URL = "https://auth.atlassian.com/oauth/token"

/**
 * OAuth2 token revocation endpoint.
 *
 * @category Endpoints
 */
export const REVOKE_URL = "https://auth.atlassian.com/oauth/revoke"

/**
 * Accessible resources endpoint (to get cloud IDs).
 *
 * @category Endpoints
 */
export const RESOURCES_URL = "https://api.atlassian.com/oauth/token/accessible-resources"

/**
 * User info endpoint.
 *
 * @category Endpoints
 */
export const ME_URL = "https://api.atlassian.com/me"

/**
 * Confluence scopes for OAuth2.
 *
 * @category Scopes
 */
export const CONFLUENCE_SCOPES = [
  "read:page:confluence",
  "write:page:confluence",
  "delete:page:confluence",
  "read:attachment:confluence",
  "write:attachment:confluence",
  "read:me",
  "offline_access"
]

/**
 * Jira scopes for OAuth2.
 *
 * @category Scopes
 */
export const JIRA_SCOPES = [
  "read:jira-work",
  "write:jira-work",
  "read:jira-user",
  "manage:jira-project",
  "manage:jira-configuration",
  "read:me",
  "offline_access"
]

/**
 * Options for building OAuth2 authorization URL.
 *
 * @category Types
 */
export interface BuildAuthUrlOptions {
  /** OAuth2 client ID */
  readonly clientId: string
  /** State parameter for CSRF protection */
  readonly state: string
  /** Local callback server port */
  readonly port: number
  /** Exact callback URL for an existing application server. */
  readonly redirectUri?: string | undefined
  /** OAuth2 scopes */
  readonly scopes: ReadonlyArray<string>
  /** PKCE code_challenge (S256). Omit to skip PKCE. */
  readonly codeChallenge?: string | undefined
}

/**
 * Build OAuth2 authorization URL.
 *
 * @category Utilities
 */
export const buildAuthUrl = (options: BuildAuthUrlOptions): string => {
  const params = new URLSearchParams({
    audience: "api.atlassian.com",
    client_id: options.clientId,
    scope: options.scopes.join(" "),
    redirect_uri: options.redirectUri ?? `http://localhost:${options.port}/callback`,
    state: options.state,
    response_type: "code",
    prompt: "consent"
  })
  if (options.codeChallenge) {
    params.set("code_challenge", options.codeChallenge)
    params.set("code_challenge_method", "S256")
  }
  return `${AUTH_URL}?${params.toString()}`
}

/**
 * Generate a cryptographically random PKCE code verifier (RFC 7636).
 * Uses Effect's platform Crypto service.
 *
 * @category PKCE
 */
export const generateCodeVerifier = (): Effect.Effect<string, PlatformError.PlatformError, Crypto.Crypto> =>
  Effect.gen(function*() {
    const cryptoService = yield* Crypto.Crypto
    const bytes = yield* cryptoService.randomBytes(32)
    return Encoding.encodeBase64Url(bytes)
  })

/**
 * Compute S256 code challenge from a code verifier (RFC 7636).
 * Uses Effect's platform Crypto service.
 *
 * @category PKCE
 */
export const computeCodeChallenge = (
  verifier: string
): Effect.Effect<string, PlatformError.PlatformError, Crypto.Crypto> =>
  Effect.gen(function*() {
    const cryptoService = yield* Crypto.Crypto
    const hash = yield* cryptoService.digest("SHA-256", new TextEncoder().encode(verifier))
    return Encoding.encodeBase64Url(hash)
  })
