/**
 * Barrel export for Atlassian OAuth2 auth utilities.
 *
 * @module
 */

// Endpoints and scopes
export {
  AUTH_URL,
  buildAuthUrl,
  type BuildAuthUrlOptions,
  computeCodeChallenge,
  CONFLUENCE_SCOPES,
  generateCodeVerifier,
  JIRA_SCOPES,
  ME_URL,
  RESOURCES_URL,
  REVOKE_URL,
  TOKEN_URL
} from "./OAuthEndpoints.js"

// Errors
export { AuthMissingError, OAuthError, OAuthNotConfiguredError, type OAuthStep } from "./OAuthErrors.js"

// Operations
export {
  buildOAuthToken,
  exchangeCodeForTokens,
  type ExchangeCodeOptions,
  getAccessibleResources,
  getUserInfo,
  refreshToken,
  revokeToken
} from "./OAuthOperations.js"

// Response schemas
export {
  type AccessibleResource,
  AccessibleResourceSchema,
  type TokenResponse,
  TokenResponseSchema,
  type UserInfo,
  UserInfoSchema
} from "./OAuthResponseSchemas.js"

// Utilities
export { generateUUID } from "./uuid.js"
