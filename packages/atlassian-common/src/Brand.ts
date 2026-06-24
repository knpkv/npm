/**
 * Branded string types for type-safe Atlassian domain values.
 *
 * **Mental model**
 *
 * - **Brand = runtime validation + compile-time narrowing**: Each brand combines
 *   an Effect `Brand.make` (throws on invalid values) with an Effect `Schema`
 *   (composable validation). The `Type` property exposes the branded type for use
 *   in type annotations.
 * - **Pattern-guarded strings**: `SpaceKey`, `IssueKey`, `ProjectKey` are regex-branded;
 *   `PageId` is non-empty branded; `ContentHash` is SHA256 hex branded.
 *
 * **Common tasks**
 *
 * - Create a custom brand: {@link makeBrandedString}, {@link makeBrandedNonEmptyString}
 * - Validate a Jira ticket key: {@link IssueKey}
 * - Validate a content hash: {@link ContentHash}
 *
 * **Gotchas**
 *
 * - Brand constructors throw synchronously on invalid input — wrap in `Effect.try` if
 *   the input is untrusted.
 *
 * @module
 */
import * as Brand from "effect/Brand"
import * as Schema from "effect/Schema"

/**
 * Create a branded string type with pattern validation.
 *
 * @example
 * ```typescript
 * import { makeBrandedString } from "@knpkv/atlassian-common"
 *
 * const IssueKey = makeBrandedString("IssueKey", /^[A-Z]+-\d+$/)
 * type IssueKey = typeof IssueKey.Type
 *
 * const key = IssueKey("PROJ-123") // OK
 * const bad = IssueKey("invalid")  // Throws
 * ```
 *
 * @category Brand
 */
export const makeBrandedString = <B extends string>(
  name: B,
  pattern: RegExp
) => {
  type BrandedType = string & Brand.Brand<B>

  const brand = Brand.make<BrandedType>((s) => pattern.test(s) || `Invalid ${name}: ${s} does not match ${pattern}`)

  const schema = Schema.String.check(Schema.isPattern(pattern)).pipe(Schema.brand(name))

  return Object.assign(brand, {
    schema,
    Type: undefined as unknown as BrandedType
  })
}

/**
 * Create a branded non-empty string type.
 *
 * @example
 * ```typescript
 * import { makeBrandedNonEmptyString } from "@knpkv/atlassian-common"
 *
 * const PageId = makeBrandedNonEmptyString("PageId")
 * type PageId = typeof PageId.Type
 *
 * const id = PageId("12345") // OK
 * const bad = PageId("")     // Throws
 * ```
 *
 * @category Brand
 */
export const makeBrandedNonEmptyString = <B extends string>(name: B) => {
  type BrandedType = string & Brand.Brand<B>

  const brand = Brand.make<BrandedType>((s) => s.length > 0 || `${name} cannot be empty`)

  const schema = Schema.NonEmptyString.pipe(Schema.brand(name))

  return Object.assign(brand, {
    schema,
    Type: undefined as unknown as BrandedType
  })
}

// Common branded types for Atlassian products

/**
 * Confluence Page ID (non-empty string).
 *
 * @category Brand
 */
export const PageId = makeBrandedNonEmptyString("PageId")
export type PageId = typeof PageId.Type

/**
 * Confluence Space Key (uppercase alphanumeric).
 *
 * @category Brand
 */
export const SpaceKey = makeBrandedString("SpaceKey", /^[A-Z][A-Z0-9]*$/)
export type SpaceKey = typeof SpaceKey.Type

/**
 * Jira Issue Key (PROJECT-123 format).
 *
 * @category Brand
 */
export const IssueKey = makeBrandedString("IssueKey", /^[A-Z][A-Z0-9]*-\d+$/)
export type IssueKey = typeof IssueKey.Type

/**
 * Jira Project Key (uppercase alphanumeric).
 *
 * @category Brand
 */
export const ProjectKey = makeBrandedString("ProjectKey", /^[A-Z][A-Z0-9]*$/)
export type ProjectKey = typeof ProjectKey.Type

/**
 * Content hash (SHA256 hex string).
 *
 * @category Brand
 */
export const ContentHash = makeBrandedString("ContentHash", /^[a-f0-9]{64}$/)
export type ContentHash = typeof ContentHash.Type
