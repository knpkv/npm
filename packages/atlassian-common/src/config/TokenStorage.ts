/**
 * Persistent token and OAuth config storage with schema validation and secure file I/O.
 *
 * **Mental model**
 *
 * - **Load returns null, not error**: {@link loadToken} and {@link loadOAuthConfig} return
 *   `null` for missing/corrupt files — callers decide whether absence is an error.
 * - **Save is atomic**: Writes go through {@link writeSecureFile} with `0o600` permissions.
 * - **Schema-gated reads**: JSON is parsed then validated via `Schema.decodeUnknown` —
 *   corrupt data is treated as absent rather than crashing.
 *
 * **Common tasks**
 *
 * - Load stored token: {@link loadToken}
 * - Persist after refresh: {@link saveToken}
 * - Check expiration: {@link isTokenExpired}
 *
 * @module
 */
import type * as Error from "@effect/platform/Error"
import * as FileSystem from "@effect/platform/FileSystem"
import type * as Path from "@effect/platform/Path"
import * as Data from "effect/Data"
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
export class FileSystemError extends Data.TaggedError("FileSystemError")<{
  readonly operation: string
  readonly path: string
  readonly cause?: unknown
}> {
  override get message(): string {
    return `Failed to ${this.operation} file at ${this.path}`
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
      Effect.mapError((cause) => new FileSystemError({ operation: "read", path: tokenPath, cause }))
    )

    const parsed = yield* Effect.sync(() => {
      try {
        return JSON.parse(content) as unknown
      } catch {
        return null
      }
    })
    if (parsed === null) {
      yield* Effect.logWarning(`Corrupted auth.json at ${tokenPath} — could not parse JSON`)
      return null
    }

    return yield* Schema.decodeUnknown(OAuthTokenSchema)(parsed).pipe(
      Effect.catchAll((e) =>
        Effect.logWarning(`Invalid token schema in ${tokenPath}: ${e}`).pipe(
          Effect.map(() => null)
        )
      )
    )
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
): Effect.Effect<
  void,
  FileSystemError | HomeDirectoryError | Error.PlatformError,
  FileSystem.FileSystem | Path.Path | HomeDirectoryTag
> =>
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
      Effect.mapError((cause) => new FileSystemError({ operation: "read", path: configPath, cause }))
    )

    const parsed = yield* Effect.sync(() => {
      try {
        return JSON.parse(content) as unknown
      } catch {
        return null
      }
    })
    if (parsed === null) {
      yield* Effect.logWarning(`Corrupted oauth config at ${configPath} — could not parse JSON`)
      return null
    }

    return yield* Schema.decodeUnknown(OAuthConfigSchema)(parsed).pipe(
      Effect.catchAll((e) =>
        Effect.logWarning(`Invalid OAuth config schema in ${configPath}: ${e}`).pipe(
          Effect.map(() => null)
        )
      )
    )
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
): Effect.Effect<
  void,
  FileSystemError | HomeDirectoryError | Error.PlatformError,
  FileSystem.FileSystem | Path.Path | HomeDirectoryTag
> =>
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
