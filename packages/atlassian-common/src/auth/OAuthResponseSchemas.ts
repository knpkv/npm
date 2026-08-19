/**
 * Effect Schema definitions for Atlassian OAuth2 API response payloads.
 *
 * **Mental model**
 *
 * - **Schema = source of truth**: {@link TokenResponseSchema}, {@link AccessibleResourceSchema},
 *   and {@link UserInfoSchema} define the wire format. Companion `type` aliases are derived
 *   via `Schema.Schema.Type` — never hand-written.
 *
 * @module
 */
import * as Schema from "effect/Schema"

/**
 * OAuth 2.0 error response body (RFC 6749 §5.2).
 *
 * Only `error` is required; providers vary on the rest, so nothing else is
 * modelled — the code is the part callers act on.
 *
 * @category Schema
 */
export const TokenErrorSchema = Schema.Struct({
  error: Schema.String
})

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
