/**
 * Atlassian OAuth2 API endpoints.
 *
 * @module
 */

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
  return `${AUTH_URL}?${params.toString()}`
}
