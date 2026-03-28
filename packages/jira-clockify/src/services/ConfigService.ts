/**
 * User configuration persistence for jcf defaults (JQL, project, billable).
 *
 * **Mental model**
 *
 * - **File-backed with defaults**: Reads `~/.jcf/config.json`, merging stored values over
 *   {@link defaultConfig}. Missing or corrupt files silently fall back to defaults.
 * - **Partial updates**: {@link ConfigServiceShape.set} merges a patch over the current config.
 *
 * @module
 */
import * as FileSystem from "@effect/platform/FileSystem"
import * as Path from "@effect/platform/Path"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { homedir } from "node:os"

export interface JcfConfig {
  readonly defaultJql: string
  readonly refreshInterval: number
  readonly projectMap: Record<string, string>
  readonly workspaceId: string | null
  readonly defaultProjectId: string | null
  readonly defaultProjectName: string | null
  readonly defaultBillable: boolean
}

const defaultConfig: JcfConfig = {
  defaultJql: "assignee = currentUser() AND status != Done ORDER BY updated DESC",
  refreshInterval: 30,
  projectMap: {},
  workspaceId: null,
  defaultProjectId: null,
  defaultProjectName: null,
  defaultBillable: true
}

export interface ConfigServiceShape {
  readonly get: Effect.Effect<JcfConfig>
  readonly set: (patch: Partial<JcfConfig>) => Effect.Effect<void>
  readonly configDir: Effect.Effect<string>
}

export class ConfigService extends Context.Tag("jcf/ConfigService")<ConfigService, ConfigServiceShape>() {}

const CONFIG_DIR = ".jcf"
const CONFIG_FILE = "config.json"

export const layer = Layer.effect(
  ConfigService,
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const home = yield* Effect.sync(() => homedir())
    const dir = path.join(home, CONFIG_DIR)
    const filePath = path.join(dir, CONFIG_FILE)

    const ensureDir = Effect.gen(function*() {
      const exists = yield* fs.exists(dir)
      if (!exists) yield* fs.makeDirectory(dir, { recursive: true })
    })

    const read: Effect.Effect<JcfConfig> = Effect.gen(function*() {
      const exists = yield* fs.exists(filePath)
      if (!exists) return defaultConfig
      const content = yield* fs.readFileString(filePath)
      const parsed = yield* Effect.try({
        try: () => JSON.parse(content) as Partial<JcfConfig>,
        catch: () => ({}) as Partial<JcfConfig>
      })
      return { ...defaultConfig, ...parsed }
    }).pipe(Effect.catchAll(() => Effect.succeed(defaultConfig)))

    const write = (config: JcfConfig) =>
      Effect.gen(function*() {
        yield* ensureDir
        yield* fs.writeFileString(filePath, JSON.stringify(config, null, 2))
      })

    return {
      get: read,
      set: (patch) =>
        Effect.gen(function*() {
          const current = yield* read
          yield* write({ ...current, ...patch })
        }).pipe(Effect.catchAll(() => Effect.void)),
      configDir: Effect.succeed(dir)
    }
  })
)
