/**
 * Token storage for OAuth credentials.
 *
 * @module
 */
import * as FileSystem from "@effect/platform/FileSystem"
import * as Path from "@effect/platform/Path"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { FileSystemError } from "../ConfluenceError.js"
import { type OAuthConfig, OAuthConfigSchema, type OAuthToken, OAuthTokenSchema } from "../Schemas.js"

const TOKEN_DIR_NAME = ".confluence"
const TOKEN_FILE_NAME = "auth.json"
const CONFIG_FILE_NAME = "config.json"

/**
 * Service for getting the home directory.
 * This allows mocking in tests.
 *
 * @category Services
 */
export interface HomeDirectory {
  readonly get: () => Effect.Effect<string>
}

/**
 * Tag for the HomeDirectory service.
 *
 * @category Services
 */
export class HomeDirectoryTag extends Context.Tag("@knpkv/confluence-to-markdown/HomeDirectory")<
  HomeDirectoryTag,
  HomeDirectory
>() {}

/**
 * Default implementation using process.env.HOME.
 *
 * @category Layers
 */
export const HomeDirectoryLive: Layer.Layer<HomeDirectoryTag> = Layer.succeed(
  HomeDirectoryTag,
  {
    get: () => Effect.sync(() => process.env.HOME ?? process.env.USERPROFILE ?? "/")
  }
)

/**
 * Get the token directory path.
 */
const getTokenDir = (): Effect.Effect<string, never, HomeDirectoryTag | Path.Path> =>
  Effect.gen(function*() {
    const homeDir = yield* HomeDirectoryTag
    const path = yield* Path.Path
    const home = yield* homeDir.get()
    return path.join(home, TOKEN_DIR_NAME)
  })

/**
 * Get the token file path.
 */
const getTokenPath = (): Effect.Effect<string, never, HomeDirectoryTag | Path.Path> =>
  Effect.gen(function*() {
    const path = yield* Path.Path
    const tokenDir = yield* getTokenDir()
    return path.join(tokenDir, TOKEN_FILE_NAME)
  })

/**
 * Get the config file path.
 */
const getConfigPath = (): Effect.Effect<string, never, HomeDirectoryTag | Path.Path> =>
  Effect.gen(function*() {
    const path = yield* Path.Path
    const tokenDir = yield* getTokenDir()
    return path.join(tokenDir, CONFIG_FILE_NAME)
  })

/**
 * Load stored OAuth token from disk.
 *
 * @returns The stored token or null if not found/invalid
 *
 * @category Token Storage
 */
export const loadToken = (): Effect.Effect<
  OAuthToken | null,
  FileSystemError,
  FileSystem.FileSystem | Path.Path | HomeDirectoryTag
> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const tokenPath = yield* getTokenPath()

    const exists = yield* fs.exists(tokenPath).pipe(
      Effect.catchAll(() => Effect.succeed(false))
    )
    if (!exists) {
      return null
    }

    const content = yield* fs.readFileString(tokenPath).pipe(
      Effect.mapError((cause) => new FileSystemError({ operation: "read", path: tokenPath, cause }))
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
 * @param token - The token to save
 *
 * @category Token Storage
 */
export const saveToken = (
  token: OAuthToken
): Effect.Effect<void, FileSystemError, FileSystem.FileSystem | Path.Path | HomeDirectoryTag> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const tokenDir = yield* getTokenDir()
    const tokenPath = yield* getTokenPath()

    yield* fs.makeDirectory(tokenDir, { recursive: true }).pipe(
      Effect.mapError((cause) => new FileSystemError({ operation: "mkdir", path: tokenDir, cause }))
    )

    yield* fs.writeFileString(tokenPath, JSON.stringify(token, null, 2)).pipe(
      Effect.mapError((cause) => new FileSystemError({ operation: "write", path: tokenPath, cause }))
    )

    // Set secure permissions (owner only)
    yield* fs.chmod(tokenPath, 0o600).pipe(
      Effect.mapError((cause) => new FileSystemError({ operation: "write", path: tokenPath, cause }))
    )
  })

/**
 * Delete stored OAuth token.
 *
 * @category Token Storage
 */
export const deleteToken = (): Effect.Effect<
  void,
  FileSystemError,
  FileSystem.FileSystem | Path.Path | HomeDirectoryTag
> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const tokenPath = yield* getTokenPath()

    yield* fs.remove(tokenPath).pipe(
      Effect.catchAll(() => Effect.void),
      Effect.mapError((cause) => new FileSystemError({ operation: "delete", path: tokenPath, cause }))
    )
  })

/**
 * Load OAuth client configuration from disk.
 *
 * @returns The stored config or null if not found/invalid
 *
 * @category OAuth Config
 */
export const loadOAuthConfig = (): Effect.Effect<
  OAuthConfig | null,
  FileSystemError,
  FileSystem.FileSystem | Path.Path | HomeDirectoryTag
> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const configPath = yield* getConfigPath()

    const exists = yield* fs.exists(configPath).pipe(
      Effect.catchAll(() => Effect.succeed(false))
    )
    if (!exists) {
      return null
    }

    const content = yield* fs.readFileString(configPath).pipe(
      Effect.mapError((cause) => new FileSystemError({ operation: "read", path: configPath, cause }))
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
 * @param config - The config to save
 *
 * @category OAuth Config
 */
export const saveOAuthConfig = (
  config: OAuthConfig
): Effect.Effect<void, FileSystemError, FileSystem.FileSystem | Path.Path | HomeDirectoryTag> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const tokenDir = yield* getTokenDir()
    const configPath = yield* getConfigPath()

    yield* fs.makeDirectory(tokenDir, { recursive: true }).pipe(
      Effect.mapError((cause) => new FileSystemError({ operation: "mkdir", path: tokenDir, cause }))
    )

    yield* fs.writeFileString(configPath, JSON.stringify(config, null, 2)).pipe(
      Effect.mapError((cause) => new FileSystemError({ operation: "write", path: configPath, cause }))
    )

    // Set secure permissions (owner only)
    yield* fs.chmod(configPath, 0o600).pipe(
      Effect.mapError((cause) => new FileSystemError({ operation: "write", path: configPath, cause }))
    )
  })
