/**
 * OAuth schema definitions shared across Atlassian tools.
 *
 * @module
 */
import * as Schema from "effect/Schema"

/**
 * Schema for OAuth user info from Atlassian.
 *
 * @category Schema
 */
export const OAuthUserSchema = Schema.Struct({
  /** Atlassian account ID */
  account_id: Schema.String,
  /** Display name */
  name: Schema.String,
  /** Email address */
  email: Schema.String
})

/**
 * Type for OAuth user info.
 *
 * @category Types
 */
export type OAuthUser = Schema.Schema.Type<typeof OAuthUserSchema>

/**
 * Schema for stored OAuth token.
 *
 * @example
 * ```typescript
 * import { OAuthTokenSchema } from "@knpkv/atlassian-common/config"
 * import * as Schema from "effect/Schema"
 *
 * const token = Schema.decodeUnknownSync(OAuthTokenSchema)({
 *   access_token: "eyJ...",
 *   refresh_token: "eyJ...",
 *   expires_at: Date.now() + 3600000,
 *   scope: "read:confluence-content.all",
 *   cloud_id: "abc123",
 *   site_url: "https://mysite.atlassian.net"
 * })
 * ```
 *
 * @category Schema
 */
export const OAuthTokenSchema = Schema.Struct({
  /** OAuth access token */
  access_token: Schema.String,
  /** OAuth refresh token */
  refresh_token: Schema.String,
  /** Token expiration timestamp (Unix ms) */
  expires_at: Schema.Number,
  /** Granted scopes */
  scope: Schema.String,
  /** Atlassian Cloud site ID */
  cloud_id: Schema.String,
  /** Site URL */
  site_url: Schema.String,
  /** Cached user info */
  user: Schema.optional(OAuthUserSchema)
})

/**
 * Type for stored OAuth token.
 *
 * @category Types
 */
export type OAuthToken = Schema.Schema.Type<typeof OAuthTokenSchema>

/**
 * Schema for OAuth client configuration.
 *
 * @category Schema
 */
export const OAuthConfigSchema = Schema.Struct({
  /** OAuth client ID from Atlassian Developer Console */
  clientId: Schema.String,
  /** OAuth client secret */
  clientSecret: Schema.String
})

/**
 * Type for OAuth client configuration.
 *
 * @category Types
 */
export type OAuthConfig = Schema.Schema.Type<typeof OAuthConfigSchema>

/**
 * Schema for Atlassian Cloud site info.
 *
 * @category Schema
 */
export const AtlassianSiteSchema = Schema.Struct({
  /** Cloud ID */
  id: Schema.String,
  /** Site name */
  name: Schema.String,
  /** Site URL */
  url: Schema.String,
  /** Available scopes */
  scopes: Schema.Array(Schema.String),
  /** Avatar URL */
  avatarUrl: Schema.optional(Schema.String)
})

/**
 * Type for Atlassian Cloud site.
 *
 * @category Types
 */
export type AtlassianSite = Schema.Schema.Type<typeof AtlassianSiteSchema>

/**
 * Schema for Atlassian user profile.
 *
 * @category Schema
 */
export const AtlassianUserSchema = Schema.Struct({
  /** Atlassian account ID */
  accountId: Schema.String,
  /** Display name */
  displayName: Schema.String,
  /** Email address (may be empty for privacy) */
  email: Schema.optional(Schema.String),
  /** Public name */
  publicName: Schema.optional(Schema.String)
})

/**
 * Type for Atlassian user profile.
 *
 * @category Types
 */
export type AtlassianUser = Schema.Schema.Type<typeof AtlassianUserSchema>
