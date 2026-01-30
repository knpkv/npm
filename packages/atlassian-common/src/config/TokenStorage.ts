/**
 * Token storage utilities for OAuth credentials.
 *
 * @module
 */
import * as FileSystem from "@effect/platform/FileSystem"
import type * as Path from "@effect/platform/Path"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { type HomeDirectoryError, type HomeDirectoryTag } from "./ConfigPaths.js"
import { ensureConfigDir, getAuthPath, getOAuthConfigPath, writeSecureFile } from "./ConfigPaths.js"
import { type OAuthConfig, OAuthConfigSchema, type OAuthToken, OAuthTokenSchema } from "./OAuthSchemas.js"

/**
 * Error during file system operations.
 *
 * @category Errors
 */
export class FileSystemError extends Error {
  readonly _tag = "FileSystemError"
  constructor(
    readonly operation: string,
    readonly path: string,
    readonly cause?: unknown
  ) {
    super(`Failed to ${operation} file at ${path}`)
    this.name = "FileSystemError"
  }
}

/**
 * Load stored OAuth token from disk.
 *
 * @param toolName - The tool name (e.g., "confluence", "jira")
 * @returns The stored token or null if not found/invalid
 *
 * @category Token Storage
 */
export const loadToken = (
  toolName: string
): Effect.Effect<
  OAuthToken | null,
  FileSystemError | HomeDirectoryError,
  FileSystem.FileSystem | Path.Path | HomeDirectoryTag
> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const tokenPath = yield* getAuthPath(toolName)

    const exists = yield* fs.exists(tokenPath).pipe(
      Effect.catchAll(() => Effect.succeed(false))
    )
    if (!exists) {
      return null
    }

    const content = yield* fs.readFileString(tokenPath).pipe(
      Effect.mapError((cause) => new FileSystemError("read", tokenPath, cause))
    )

    let parsed: unknown
    try {
      parsed = JSON.parse(content)
    } catch {
      return null
    }

    const decoded = yield* Schema.decodeUnknown(OAuthTokenSchema)(parsed).pipe(
      Effect.catchAll(() => Effect.succeed(null))
    )

    return decoded
  })

/**
 * Save OAuth token to disk with secure permissions.
 *
 * @param toolName - The tool name (e.g., "confluence", "jira")
 * @param token - The token to save
 *
 * @category Token Storage
 */
export const saveToken = (
  toolName: string,
  token: OAuthToken
): Effect.Effect<void, FileSystemError | HomeDirectoryError, FileSystem.FileSystem | Path.Path | HomeDirectoryTag> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    yield* ensureConfigDir(toolName)
    const tokenPath = yield* getAuthPath(toolName)

    yield* writeSecureFile(tokenPath, JSON.stringify(token, null, 2)).pipe(
      Effect.provideService(FileSystem.FileSystem, fs)
    )
  })

/**
 * Delete stored OAuth token.
 *
 * @param toolName - The tool name (e.g., "confluence", "jira")
 *
 * @category Token Storage
 */
export const deleteToken = (
  toolName: string
): Effect.Effect<void, FileSystemError | HomeDirectoryError, FileSystem.FileSystem | Path.Path | HomeDirectoryTag> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const tokenPath = yield* getAuthPath(toolName)

    yield* fs.remove(tokenPath).pipe(
      Effect.catchAll(() => Effect.void)
    )
  })

/**
 * Load OAuth client configuration from disk.
 *
 * @param toolName - The tool name (e.g., "confluence", "jira")
 * @returns The stored config or null if not found/invalid
 *
 * @category OAuth Config
 */
export const loadOAuthConfig = (
  toolName: string
): Effect.Effect<
  OAuthConfig | null,
  FileSystemError | HomeDirectoryError,
  FileSystem.FileSystem | Path.Path | HomeDirectoryTag
> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const configPath = yield* getOAuthConfigPath(toolName)

    const exists = yield* fs.exists(configPath).pipe(
      Effect.catchAll(() => Effect.succeed(false))
    )
    if (!exists) {
      return null
    }

    const content = yield* fs.readFileString(configPath).pipe(
      Effect.mapError((cause) => new FileSystemError("read", configPath, cause))
    )

    let parsed: unknown
    try {
      parsed = JSON.parse(content)
    } catch {
      return null
    }

    const decoded = yield* Schema.decodeUnknown(OAuthConfigSchema)(parsed).pipe(
      Effect.catchAll(() => Effect.succeed(null))
    )

    return decoded
  })

/**
 * Save OAuth client configuration to disk with secure permissions.
 *
 * @param toolName - The tool name (e.g., "confluence", "jira")
 * @param config - The config to save
 *
 * @category OAuth Config
 */
export const saveOAuthConfig = (
  toolName: string,
  config: OAuthConfig
): Effect.Effect<void, FileSystemError | HomeDirectoryError, FileSystem.FileSystem | Path.Path | HomeDirectoryTag> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    yield* ensureConfigDir(toolName)
    const configPath = yield* getOAuthConfigPath(toolName)

    yield* writeSecureFile(configPath, JSON.stringify(config, null, 2)).pipe(
      Effect.provideService(FileSystem.FileSystem, fs)
    )
  })

/**
 * Check if token is expired or about to expire.
 *
 * @param token - The token to check
 * @param bufferMs - Buffer time in ms before expiration (default: 5 minutes)
 * @returns True if token is expired or will expire within buffer time
 *
 * @category Utilities
 */
export const isTokenExpired = (token: OAuthToken, bufferMs: number = 5 * 60 * 1000): boolean =>
  Date.now() >= token.expires_at - bufferMs
