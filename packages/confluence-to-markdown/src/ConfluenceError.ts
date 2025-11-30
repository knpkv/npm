/**
 * Error types for Confluence operations.
 *
 * @module
 */
import * as Data from "effect/Data"

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
}> {}

/**
 * Error thrown when .confluence.json parsing fails.
 *
 * @category Errors
 */
export class ConfigParseError extends Data.TaggedError("ConfigParseError")<{
  readonly path: string
  readonly cause: unknown
}> {}

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
 *   Effect.catchTag("AuthMissingError", () =>
 *     Effect.sync(() => console.error("Set CONFLUENCE_API_KEY or run: confluence auth login"))
 *   )
 * )
 * ```
 *
 * @category Errors
 */
export class AuthMissingError extends Data.TaggedError("AuthMissingError")<{
  readonly message: string
}> {
  constructor() {
    super({ message: "CONFLUENCE_API_KEY env var or OAuth2 credentials required" })
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
  readonly retryAfter?: number
}> {}

/**
 * Error thrown when HTML/Markdown conversion fails.
 *
 * @category Errors
 */
export class ConversionError extends Data.TaggedError("ConversionError")<{
  readonly direction: "htmlToMarkdown" | "markdownToHtml"
  readonly cause: unknown
}> {}

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
}> {}

/**
 * Error thrown when file system operation fails.
 *
 * @category Errors
 */
export class FileSystemError extends Data.TaggedError("FileSystemError")<{
  readonly operation: "read" | "write" | "delete" | "mkdir" | "rename"
  readonly path: string
  readonly cause: unknown
}> {}

/**
 * Error thrown when OAuth2 flow fails.
 *
 * @category Errors
 */
export class OAuthError extends Data.TaggedError("OAuthError")<{
  readonly step: "authorize" | "token" | "refresh"
  readonly cause: unknown
}> {}

/**
 * Error thrown when front-matter parsing fails.
 *
 * @category Errors
 */
export class FrontMatterError extends Data.TaggedError("FrontMatterError")<{
  readonly path: string
  readonly cause: unknown
}> {}

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
  | ConflictError
  | FileSystemError
  | OAuthError
  | FrontMatterError

/**
 * Type guard to check if error is a ConfluenceError.
 *
 * @param error - The error to check
 * @returns True if error is a ConfluenceError
 *
 * @category Utilities
 */
export const isConfluenceError = (error: unknown): error is ConfluenceError =>
  typeof error === "object" &&
  error !== null &&
  "_tag" in error &&
  [
    "ConfigNotFoundError",
    "ConfigParseError",
    "ConfigError",
    "AuthMissingError",
    "ApiError",
    "RateLimitError",
    "ConversionError",
    "ConflictError",
    "FileSystemError",
    "OAuthError",
    "FrontMatterError"
  ].includes((error as { _tag: string })._tag)
