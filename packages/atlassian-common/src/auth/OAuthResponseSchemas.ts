/**
 * OAuth2 API response schemas.
 *
 * @module
 */
import * as Schema from "effect/Schema"

/**
 * Schema for OAuth2 token response from Atlassian.
 *
 * @category Schema
 */
export const TokenResponseSchema = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.String,
  expires_in: Schema.Number,
  scope: Schema.String,
  token_type: Schema.String
})

/**
 * Type for OAuth2 token response.
 *
 * @category Types
 */
export type TokenResponse = Schema.Schema.Type<typeof TokenResponseSchema>

/**
 * Schema for accessible resource (site) from Atlassian.
 *
 * @category Schema
 */
export const AccessibleResourceSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  url: Schema.String,
  scopes: Schema.Array(Schema.String),
  avatarUrl: Schema.optional(Schema.String)
})

/**
 * Type for accessible resource.
 *
 * @category Types
 */
export type AccessibleResource = Schema.Schema.Type<typeof AccessibleResourceSchema>

/**
 * Schema for user info from /me endpoint.
 *
 * @category Schema
 */
export const UserInfoSchema = Schema.Struct({
  account_id: Schema.String,
  name: Schema.String,
  email: Schema.String
})

/**
 * Type for user info.
 *
 * @category Types
 */
export type UserInfo = Schema.Schema.Type<typeof UserInfoSchema>
