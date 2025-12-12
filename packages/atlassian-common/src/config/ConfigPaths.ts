/**
 * XDG-compliant configuration path utilities for Atlassian tools.
 *
 * @module
 */
import * as FileSystem from "@effect/platform/FileSystem"
import * as Path from "@effect/platform/Path"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"

/**
 * Service for getting the home directory.
 * Allows mocking in tests.
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
export class HomeDirectoryTag extends Context.Tag("@knpkv/atlassian-common/HomeDirectory")<
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
 * XDG config directory for Atlassian tools.
 * Returns ~/.config/atlassian by default.
 *
 * @category Utilities
 */
export const getConfigDir = (
  toolName?: string
): Effect.Effect<string, never, HomeDirectoryTag | Path.Path> =>
  Effect.gen(function*() {
    const homeDir = yield* HomeDirectoryTag
    const path = yield* Path.Path
    const home = yield* homeDir.get()

    // Use XDG_CONFIG_HOME if set, otherwise ~/.config
    const xdgConfig = process.env.XDG_CONFIG_HOME ?? path.join(home, ".config")
    const baseDir = path.join(xdgConfig, "atlassian")

    return toolName ? path.join(baseDir, toolName) : baseDir
  })

/**
 * Get auth file path for a specific tool.
 *
 * @category Utilities
 */
export const getAuthPath = (
  toolName: string
): Effect.Effect<string, never, HomeDirectoryTag | Path.Path> =>
  Effect.gen(function*() {
    const path = yield* Path.Path
    const configDir = yield* getConfigDir(toolName)
    return path.join(configDir, "auth.json")
  })

/**
 * Get OAuth config file path for a specific tool.
 *
 * @category Utilities
 */
export const getOAuthConfigPath = (
  toolName: string
): Effect.Effect<string, never, HomeDirectoryTag | Path.Path> =>
  Effect.gen(function*() {
    const path = yield* Path.Path
    const configDir = yield* getConfigDir(toolName)
    return path.join(configDir, "oauth.json")
  })

/**
 * Ensure config directory exists with secure permissions.
 *
 * @category Utilities
 */
export const ensureConfigDir = (
  toolName: string
): Effect.Effect<string, never, FileSystem.FileSystem | Path.Path | HomeDirectoryTag> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const configDir = yield* getConfigDir(toolName)

    yield* fs.makeDirectory(configDir, { recursive: true }).pipe(
      Effect.catchAll(() => Effect.void)
    )

    // Set secure permissions (owner only)
    yield* fs.chmod(configDir, 0o700).pipe(
      Effect.catchAll(() => Effect.void)
    )

    return configDir
  })

/**
 * Write file with secure permissions (600).
 *
 * @category Utilities
 */
export const writeSecureFile = (
  filePath: string,
  content: string
): Effect.Effect<void, never, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem

    yield* fs.writeFileString(filePath, content).pipe(
      Effect.catchAll(() => Effect.void)
    )

    // Set secure permissions (owner only)
    yield* fs.chmod(filePath, 0o600).pipe(
      Effect.catchAll(() => Effect.void)
    )
  })
