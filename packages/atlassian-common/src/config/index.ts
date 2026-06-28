/**
 * Barrel export for config path utilities, schemas, and token storage.
 *
 * @module
 */

// Config paths
export {
  ensureConfigDir,
  getAuthPath,
  getConfigDir,
  getOAuthConfigPath,
  getProfilesPath,
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

// Auth profiles
export {
  type AuthProfile,
  AuthProfileSchema,
  type AuthProfilesFile,
  AuthProfilesFileSchema,
  deleteActiveProfile,
  deleteProfile,
  deleteProfileBySelector,
  findProfile,
  loadActiveProfile,
  loadActiveProfileToken,
  loadProfiles,
  profileFromToken,
  profileIdFromToken,
  profileNameFromToken,
  saveProfiles,
  saveProfileToken,
  setActiveProfile,
  setActiveProfileBySelector
} from "./AuthProfiles.js"
