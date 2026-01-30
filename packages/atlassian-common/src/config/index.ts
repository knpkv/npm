/**
 * Configuration utilities for Atlassian tools.
 *
 * @module
 */

// Config paths
export {
  ensureConfigDir,
  getAuthPath,
  getConfigDir,
  getOAuthConfigPath,
  type HomeDirectory,
  HomeDirectoryError,
  HomeDirectoryLive,
  HomeDirectoryTag,
  writeSecureFile
} from "./ConfigPaths.js"

// OAuth schemas
export {
  type AtlassianSite,
  AtlassianSiteSchema,
  type AtlassianUser,
  AtlassianUserSchema,
  type OAuthConfig,
  OAuthConfigSchema,
  type OAuthToken,
  OAuthTokenSchema,
  type OAuthUser,
  OAuthUserSchema
} from "./OAuthSchemas.js"

// Token storage
export {
  deleteToken,
  FileSystemError,
  isTokenExpired,
  loadOAuthConfig,
  loadToken,
  saveOAuthConfig,
  saveToken
} from "./TokenStorage.js"
