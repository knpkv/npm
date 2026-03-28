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
import * as Effect from "effect/Effect"
import * as Encoding from "effect/Encoding"

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
    redirect_uri: `http://localhost:${options.port}/callback`,
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
 * Uses Web Crypto API (available in Node 18+, Deno, browsers).
 *
 * @category PKCE
 */
export const generateCodeVerifier = (): string => {
  const bytes = new Uint8Array(32)
  globalThis.crypto.getRandomValues(bytes)
  return Encoding.encodeBase64Url(bytes)
}

/**
 * Compute S256 code challenge from a code verifier (RFC 7636).
 * Uses Web Crypto `subtle.digest` — returns Effect since digest is async.
 *
 * @category PKCE
 */
export const computeCodeChallenge = (verifier: string): Effect.Effect<string> =>
  Effect.promise(() => globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))).pipe(
    Effect.map((hash) => Encoding.encodeBase64Url(new Uint8Array(hash)))
  )
