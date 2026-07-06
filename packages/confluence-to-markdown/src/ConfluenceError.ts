/**
 * Error types for Confluence operations.
 *
 * @module
 */
import * as Data from "effect/Data"
import * as Predicate from "effect/Predicate"

/**
 * Error thrown when .confluence.json is not found.
 *
 * @example
 * ```typescript
 * import { Effect } from "effect"
 * import { ConfigNotFoundError } from "@knpkv/confluence-to-markdown/ConfluenceError"
 *
 * Effect.gen(function* () {
 *   // ... operation that needs config
 * }).pipe(
 *   Effect.catchTag("ConfigNotFoundError", (error) =>
 *     Effect.sync(() => console.error(`Config not found at: ${error.path}`))
 *   )
 * )
 * ```
 *
 * @category Errors
 */
export class ConfigNotFoundError extends Data.TaggedError("ConfigNotFoundError")<{
  readonly path: string
  readonly message: string
}> {
  constructor(params: { path: string }) {
    super({
      path: params.path,
      message: `Config not found: ${params.path}\nRun 'confluence workspace clone' to initialize.`
    })
  }
}

/**
 * Error thrown when .confluence.json parsing fails.
 *
 * @category Errors
 */
export class ConfigParseError extends Data.TaggedError("ConfigParseError")<{
  readonly path: string
  readonly cause: unknown
  readonly message: string
}> {
  constructor(params: { path: string; cause: unknown }) {
    super({
      path: params.path,
      cause: params.cause,
      message: `Invalid config file: ${params.path}`
    })
  }
}

/**
 * Error thrown when configuration validation fails.
 *
 * @category Errors
 */
export class ConfigError extends Data.TaggedError("ConfigError")<{
  readonly message: string
}> {}

/**
 * Error thrown when authentication is missing.
 *
 * @example
 * ```typescript
 * import { Effect } from "effect"
 * import { AuthMissingError } from "@knpkv/confluence-to-markdown/ConfluenceError"
 *
 * Effect.gen(function* () {
 *   // ... operation that needs auth
 * }).pipe(
 *   Effect.catchTag("AuthMissingError", (error) =>
 *     Effect.sync(() => console.error(error.message))
 *   )
 * )
 * ```
 *
 * @category Errors
 */
export class AuthMissingError extends Data.TaggedError("AuthMissingError")<{
  readonly message: string
}> {
  constructor(params?: { message?: string }) {
    super({
      message: params?.message ??
        "Not authenticated. Run 'confluence login' or set CONFLUENCE_API_KEY + CONFLUENCE_EMAIL"
    })
  }
}

/**
 * Error thrown when Confluence API request fails.
 *
 * @category Errors
 */
export class ApiError extends Data.TaggedError("ApiError")<{
  readonly status: number
  readonly message: string
  readonly endpoint: string
  readonly pageId?: string
}> {}

/**
 * Error thrown when rate limit is exceeded.
 *
 * @category Errors
 */
export class RateLimitError extends Data.TaggedError("RateLimitError")<{
  readonly retryAfter?: number | undefined
  readonly message: string
}> {
  constructor(params?: { retryAfter?: number }) {
    const message = params?.retryAfter
      ? `Rate limited. Retry after ${params.retryAfter}s.`
      : "Rate limited. Please wait and try again."
    super({ retryAfter: params?.retryAfter, message })
  }
}

/**
 * Direction of an ADF/Markdown conversion.
 *
 * @category Errors
 */
export type ConversionDirection = "adfToMarkdown" | "markdownToAdf"

/**
 * Error thrown when ADF/Markdown conversion fails.
 *
 * @category Errors
 */
export class ConversionError extends Data.TaggedError("ConversionError")<{
  readonly direction: ConversionDirection
  readonly cause: unknown
  readonly message: string
}> {
  constructor(params: { direction: ConversionDirection; cause: unknown }) {
    super({
      direction: params.direction,
      cause: params.cause,
      message: `Conversion failed (${params.direction}): ${params.cause}`
    })
  }
}

/**
 * Issue produced by ADF JSON Schema validation.
 *
 * @category Errors
 */
export interface AdfSchemaIssue {
  readonly instancePath?: string
  readonly schemaPath?: string
  readonly keyword?: string
  readonly message?: string
  readonly params?: Record<string, unknown>
}

/**
 * Error thrown when an ADF document fails JSON Schema validation.
 *
 * @category Errors
 */
export class AdfSchemaError extends Data.TaggedError("AdfSchemaError")<{
  readonly direction: "incoming" | "outgoing"
  readonly issues: ReadonlyArray<AdfSchemaIssue>
  readonly message: string
}> {
  constructor(params: { direction: "incoming" | "outgoing"; issues: ReadonlyArray<AdfSchemaIssue> }) {
    super({
      direction: params.direction,
      issues: params.issues,
      message: `ADF schema validation failed (${params.direction}): ${params.issues.length} issue(s)`
    })
  }
}

/**
 * Error thrown when the wrapped @atlaskit transformer libraries throw.
 *
 * @category Errors
 */
export class AtlaskitTransformersError extends Data.TaggedError("AtlaskitTransformersError")<{
  readonly cause: unknown
  readonly message: string
}> {
  constructor(params: { cause: unknown }) {
    super({
      cause: params.cause,
      message: `Atlaskit transformer failed: ${
        Predicate.isError(params.cause) ? params.cause.message : String(params.cause)
      }`
    })
  }
}

/**
 * Error thrown when sync conflict is detected.
 *
 * @category Errors
 */
export class ConflictError extends Data.TaggedError("ConflictError")<{
  readonly pageId: string
  readonly localVersion: number
  readonly remoteVersion: number
  readonly path: string
  readonly message: string
}> {
  constructor(params: { pageId: string; localVersion: number; remoteVersion: number; path: string }) {
    super({
      ...params,
      message: `Conflict: ${params.path} (local v${params.localVersion} vs remote v${params.remoteVersion})`
    })
  }
}

/**
 * Error thrown when file system operation fails.
 *
 * @category Errors
 */
export class FileSystemError extends Data.TaggedError("FileSystemError")<{
  readonly operation: "read" | "write" | "delete" | "mkdir" | "rename"
  readonly path: string
  readonly cause: unknown
  readonly message: string
}> {
  constructor(params: { operation: "read" | "write" | "delete" | "mkdir" | "rename"; path: string; cause: unknown }) {
    super({
      ...params,
      message: `File ${params.operation} failed: ${params.path}`
    })
  }
}

/**
 * Error thrown when OAuth2 flow fails.
 *
 * @category Errors
 */
export class OAuthError extends Data.TaggedError("OAuthError")<{
  readonly step: "authorize" | "token" | "refresh" | "revoke"
  readonly cause: unknown
  readonly message: string
}> {
  constructor(params: { step: "authorize" | "token" | "refresh" | "revoke"; cause: unknown }) {
    super({
      ...params,
      message: `OAuth ${params.step} failed: ${params.cause}`
    })
  }
}

/**
 * Error thrown when front-matter parsing fails.
 *
 * @category Errors
 */
export class FrontMatterError extends Data.TaggedError("FrontMatterError")<{
  readonly path: string
  readonly cause: unknown
  readonly message: string
}> {
  constructor(params: { path: string; cause: unknown }) {
    super({
      ...params,
      message: `Invalid front-matter in: ${params.path}`
    })
  }
}

/**
 * Error thrown when directory structure is inconsistent.
 *
 * @example
 * ```typescript
 * import { Effect } from "effect"
 * import { StructureError } from "@knpkv/confluence-to-markdown/ConfluenceError"
 *
 * Effect.gen(function* () {
 *   // ... validate structure
 * }).pipe(
 *   Effect.catchTag("StructureError", (error) =>
 *     Effect.sync(() => console.error(`${error.message}\nAdvice: ${error.advice}`))
 *   )
 * )
 * ```
 *
 * @category Errors
 */
export class StructureError extends Data.TaggedError("StructureError")<{
  readonly path: string
  readonly advice: string
  readonly message: string
}> {}

/**
 * Error thrown when Confluence media nodes cannot be resolved to attachment URLs.
 *
 * @category Errors
 */
export class AttachmentResolutionError extends Data.TaggedError("AttachmentResolutionError")<{
  readonly pageId: string
  readonly message: string
}> {
  constructor(params: { pageId: string }) {
    super({
      pageId: params.pageId,
      message: `Could not resolve Confluence media attachments for page ${params.pageId}`
    })
  }
}

/**
 * Union of all Confluence errors.
 *
 * @category Errors
 */
export type ConfluenceError =
  | ConfigNotFoundError
  | ConfigParseError
  | ConfigError
  | AuthMissingError
  | ApiError
  | RateLimitError
  | ConversionError
  | AdfSchemaError
  | AtlaskitTransformersError
  | ConflictError
  | FileSystemError
  | OAuthError
  | FrontMatterError
  | StructureError
  | AttachmentResolutionError

/**
 * Type guard to check if error is a ConfluenceError.
 *
 * @param error - The error to check
 * @returns True if error is a ConfluenceError
 *
 * @category Utilities
 */
export const isConfluenceError = (error: unknown): error is ConfluenceError =>
  Predicate.hasProperty(error, "_tag") &&
  typeof error._tag === "string" &&
  [
    "ConfigNotFoundError",
    "ConfigParseError",
    "ConfigError",
    "AuthMissingError",
    "ApiError",
    "RateLimitError",
    "ConversionError",
    "AdfSchemaError",
    "AtlaskitTransformersError",
    "ConflictError",
    "FileSystemError",
    "OAuthError",
    "FrontMatterError",
    "StructureError",
    "AttachmentResolutionError"
  ].includes(error._tag)
