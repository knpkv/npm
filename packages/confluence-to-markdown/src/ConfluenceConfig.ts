/**
 * Configuration service for Confluence sync.
 *
 * @module
 */
import * as FileSystem from "@effect/platform/FileSystem"
import * as Path from "@effect/platform/Path"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import type { PageId } from "./Brand.js"
import { ConfigNotFoundError, ConfigParseError } from "./ConfluenceError.js"
import type { ConfluenceConfigFile } from "./Schemas.js"
import { ConfluenceConfigFileSchema } from "./Schemas.js"

/**
 * Configuration service for Confluence operations.
 *
 * @example
 * ```typescript
 * import { ConfluenceConfig } from "@knpkv/confluence-to-markdown/ConfluenceConfig"
 * import { Effect } from "effect"
 *
 * const program = Effect.gen(function* () {
 *   const config = yield* ConfluenceConfig
 *   console.log(config.rootPageId)
 *   console.log(config.baseUrl)
 * })
 * ```
 *
 * @category Config
 */
export class ConfluenceConfig extends Context.Tag(
  "@knpkv/confluence-to-markdown/ConfluenceConfig"
)<
  ConfluenceConfig,
  {
    /** Root page ID to sync from */
    readonly rootPageId: PageId
    /** Confluence Cloud base URL */
    readonly baseUrl: string
    /** Optional space key */
    readonly spaceKey?: string
    /** Local docs path */
    readonly docsPath: string
    /** Glob patterns to exclude */
    readonly excludePatterns: ReadonlyArray<string>
    /** Save original Confluence HTML alongside markdown */
    readonly saveSource: boolean
  }
>() {}

/**
 * Default config file name.
 */
const CONFIG_FILE_NAME = ".confluence.json"

/**
 * Load configuration from a file.
 */
const loadConfig = (
  configPath: string
): Effect.Effect<ConfluenceConfigFile, ConfigNotFoundError | ConfigParseError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem

    const exists = yield* fs.exists(configPath).pipe(
      Effect.catchAll(() => Effect.succeed(false))
    )
    if (!exists) {
      return yield* Effect.fail(new ConfigNotFoundError({ path: configPath }))
    }

    const content = yield* fs.readFileString(configPath).pipe(
      Effect.mapError((cause) => new ConfigParseError({ path: configPath, cause }))
    )

    const json = yield* Effect.try({
      try: () => JSON.parse(content) as unknown,
      catch: (cause) => new ConfigParseError({ path: configPath, cause })
    })

    return yield* Schema.decodeUnknown(ConfluenceConfigFileSchema)(json).pipe(
      Effect.mapError((cause) => new ConfigParseError({ path: configPath, cause }))
    )
  })

/**
 * Layer that provides ConfluenceConfig from a config file.
 *
 * @example
 * ```typescript
 * import { ConfluenceConfig } from "@knpkv/confluence-to-markdown/ConfluenceConfig"
 * import { NodeFileSystem } from "@effect/platform-node"
 * import { Effect } from "effect"
 *
 * const program = Effect.gen(function* () {
 *   const config = yield* ConfluenceConfig
 *   console.log(config.rootPageId)
 * })
 *
 * Effect.runPromise(
 *   program.pipe(
 *     Effect.provide(ConfluenceConfig.layer()),
 *     Effect.provide(NodeFileSystem.layer)
 *   )
 * )
 * ```
 *
 * @category Layers
 */
export const layer = (
  configPath?: string
): Layer.Layer<ConfluenceConfig, ConfigNotFoundError | ConfigParseError, FileSystem.FileSystem | Path.Path> =>
  Layer.effect(
    ConfluenceConfig,
    Effect.gen(function*() {
      const path = yield* Path.Path
      const resolvedPath = configPath ?? path.join(process.cwd(), CONFIG_FILE_NAME)
      const config = yield* loadConfig(resolvedPath)

      return ConfluenceConfig.of({
        rootPageId: config.rootPageId,
        baseUrl: config.baseUrl,
        ...(config.spaceKey !== undefined ? { spaceKey: config.spaceKey } : {}),
        docsPath: config.docsPath,
        excludePatterns: config.excludePatterns,
        saveSource: config.saveSource
      })
    })
  )

/**
 * Layer that provides ConfluenceConfig with direct values.
 *
 * @category Layers
 */
export const layerFromValues = (
  config: ConfluenceConfigFile
): Layer.Layer<ConfluenceConfig> =>
  Layer.succeed(
    ConfluenceConfig,
    ConfluenceConfig.of({
      rootPageId: config.rootPageId,
      baseUrl: config.baseUrl,
      ...(config.spaceKey !== undefined ? { spaceKey: config.spaceKey } : {}),
      docsPath: config.docsPath,
      excludePatterns: config.excludePatterns,
      saveSource: config.saveSource
    })
  )

/**
 * Create a new config file.
 *
 * @category Utilities
 */
export const createConfigFile = (
  rootPageId: string,
  baseUrl: string,
  configPath?: string
): Effect.Effect<string, ConfigParseError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const pathService = yield* Path.Path

    const resolvedPath = configPath ?? pathService.join(process.cwd(), CONFIG_FILE_NAME)

    const config: ConfluenceConfigFile = {
      rootPageId: rootPageId as PageId,
      baseUrl,
      docsPath: ".docs/confluence",
      excludePatterns: [],
      saveSource: false
    }

    // Validate the config
    yield* Schema.decodeUnknown(ConfluenceConfigFileSchema)(config).pipe(
      Effect.mapError((cause) => new ConfigParseError({ path: resolvedPath, cause }))
    )

    const content = JSON.stringify(config, null, 2)
    yield* fs.writeFileString(resolvedPath, content).pipe(
      Effect.mapError((cause) => new ConfigParseError({ path: resolvedPath, cause }))
    )

    return resolvedPath
  })
