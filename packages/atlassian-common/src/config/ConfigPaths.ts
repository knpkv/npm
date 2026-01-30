/**
 * XDG-compliant configuration path utilities for Atlassian tools.
 *
 * @module
 */
import * as FileSystem from "@effect/platform/FileSystem"
import * as Path from "@effect/platform/Path"
import * as Config from "effect/Config"
import * as Context from "effect/Context"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"

/**
 * Error when home directory cannot be determined.
 *
 * @category Errors
 */
export class HomeDirectoryError extends Data.TaggedError("HomeDirectoryError")<{
  readonly cause?: unknown
}> {
  get message(): string {
    return "Cannot determine home directory: HOME/USERPROFILE not set"
  }
}

/**
 * Service for getting the home directory.
 * Allows mocking in tests.
 *
 * @category Services
 */
export interface HomeDirectory {
  readonly get: () => Effect.Effect<string, HomeDirectoryError>
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

const HomeConfig = Config.option(Config.string("HOME")).pipe(
  Config.orElse(() => Config.option(Config.string("USERPROFILE")))
)

/**
 * Default implementation using HOME/USERPROFILE env vars.
 *
 * @category Layers
 */
export const HomeDirectoryLive: Layer.Layer<HomeDirectoryTag> = Layer.succeed(
  HomeDirectoryTag,
  {
    get: () =>
      Effect.gen(function*() {
        const opt = yield* Effect.orDie(HomeConfig)
        return yield* Option.match(opt, {
          onNone: () => Effect.fail(new HomeDirectoryError({})),
          onSome: (home) => Effect.succeed(home)
        })
      })
  }
)

const XdgConfigHome = Config.option(Config.string("XDG_CONFIG_HOME"))

/**
 * XDG config directory for Atlassian tools.
 * Returns ~/.config/atlassian by default.
 *
 * @category Utilities
 */
export const getConfigDir = (
  toolName?: string
): Effect.Effect<string, HomeDirectoryError, HomeDirectoryTag | Path.Path> =>
  Effect.gen(function*() {
    const homeDir = yield* HomeDirectoryTag
    const pathSvc = yield* Path.Path
    const home = yield* homeDir.get()

    // Use XDG_CONFIG_HOME if set, otherwise ~/.config
    const xdgOpt = yield* Effect.orDie(XdgConfigHome)
    const xdgConfig = Option.getOrElse(xdgOpt, () => pathSvc.join(home, ".config"))
    const baseDir = pathSvc.join(xdgConfig, "atlassian")

    return toolName ? pathSvc.join(baseDir, toolName) : baseDir
  })

/**
 * Get auth file path for a specific tool.
 *
 * @category Utilities
 */
export const getAuthPath = (
  toolName: string
): Effect.Effect<string, HomeDirectoryError, HomeDirectoryTag | Path.Path> =>
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
): Effect.Effect<string, HomeDirectoryError, HomeDirectoryTag | Path.Path> =>
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
): Effect.Effect<string, HomeDirectoryError, FileSystem.FileSystem | Path.Path | HomeDirectoryTag> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const configDir = yield* getConfigDir(toolName)

    yield* fs.makeDirectory(configDir, { recursive: true }).pipe(
      Effect.catchAll((err) => Effect.logWarning(`Failed to create config directory ${configDir}: ${err}`))
    )

    // Set secure permissions (owner only)
    yield* fs.chmod(configDir, 0o700).pipe(
      Effect.catchAll((err) => Effect.logWarning(`Failed to set secure permissions on ${configDir}: ${err}`))
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
      Effect.catchAll((err) => Effect.logWarning(`Failed to write file ${filePath}: ${err}`))
    )

    // Set secure permissions (owner only)
    yield* fs.chmod(filePath, 0o600).pipe(
      Effect.catchAll((err) => Effect.logWarning(`Failed to set secure permissions on ${filePath}: ${err}`))
    )
  })
