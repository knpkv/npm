/**
 * Branded types for type-safe Confluence identifiers.
 *
 * @module
 */
import * as Brand from "effect/Brand"
import * as Schema from "effect/Schema"

/**
 * Branded type for Confluence page IDs.
 *
 * @example
 * ```typescript
 * import { PageId } from "@knpkv/confluence-to-markdown/Brand"
 *
 * const id = PageId("12345") // Valid
 * const invalid = PageId("") // Throws BrandErrors
 * ```
 *
 * @category Brand
 */
export type PageId = string & Brand.Brand<"PageId">

/**
 * Refined brand constructor for PageId.
 *
 * @category Brand
 */
export const PageId = Brand.refined<PageId>(
  (s): s is PageId => typeof s === "string" && s.length > 0,
  (s) => Brand.error(`Invalid page ID: "${s}" (must be non-empty string)`)
)

/**
 * Schema for PageId validation and parsing.
 *
 * @category Schema
 */
export const PageIdSchema = Schema.String.pipe(
  Schema.nonEmptyString(),
  Schema.brand("PageId")
)

/**
 * Branded type for Confluence space IDs.
 *
 * @example
 * ```typescript
 * import { SpaceId } from "@knpkv/confluence-to-markdown/Brand"
 *
 * const id = SpaceId("12345") // Valid
 * ```
 *
 * @category Brand
 */
export type SpaceId = string & Brand.Brand<"SpaceId">

/**
 * Refined brand constructor for SpaceId.
 *
 * @category Brand
 */
export const SpaceId = Brand.refined<SpaceId>(
  (s): s is SpaceId => typeof s === "string" && s.length > 0,
  (s) => Brand.error(`Invalid space ID: "${s}" (must be non-empty string)`)
)

/**
 * Schema for SpaceId validation.
 *
 * @category Schema
 */
export const SpaceIdSchema = Schema.String.pipe(
  Schema.nonEmptyString(),
  Schema.brand("SpaceId")
)

/**
 * Branded type for Confluence space keys.
 *
 * @example
 * ```typescript
 * import { SpaceKey } from "@knpkv/confluence-to-markdown/Brand"
 *
 * const key = SpaceKey("DOCS") // Valid
 * ```
 *
 * @category Brand
 */
export type SpaceKey = string & Brand.Brand<"SpaceKey">

/**
 * Refined brand constructor for SpaceKey.
 *
 * @category Brand
 */
export const SpaceKey = Brand.refined<SpaceKey>(
  (s): s is SpaceKey => typeof s === "string" && s.length > 0 && /^[A-Z0-9]+$/.test(s),
  (s) => Brand.error(`Invalid space key: "${s}" (must be uppercase alphanumeric)`)
)

/**
 * Schema for SpaceKey validation.
 *
 * @category Schema
 */
export const SpaceKeySchema = Schema.String.pipe(
  Schema.nonEmptyString(),
  Schema.pattern(/^[A-Z0-9]+$/),
  Schema.brand("SpaceKey")
)

/**
 * Branded type for content hash (SHA256).
 *
 * @category Brand
 */
export type ContentHash = string & Brand.Brand<"ContentHash">

/**
 * Refined brand constructor for ContentHash.
 *
 * @category Brand
 */
export const ContentHash = Brand.refined<ContentHash>(
  (s): s is ContentHash => typeof s === "string" && /^[a-f0-9]{64}$/.test(s),
  (s) => Brand.error(`Invalid content hash: "${s}" (must be 64-char hex string)`)
)

/**
 * Schema for ContentHash validation.
 *
 * @category Schema
 */
export const ContentHashSchema = Schema.String.pipe(
  Schema.pattern(/^[a-f0-9]{64}$/),
  Schema.brand("ContentHash")
)
