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
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Path from "effect/Path"
import { HomeDirectory } from "./HomeDirectory.js"

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

export class ConfigService extends Context.Service<ConfigService, ConfigServiceShape>()("jcf/ConfigService") {}

const CONFIG_DIR = ".jcf"
const CONFIG_FILE = "config.json"

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)

const stringRecord = (value: unknown): Record<string, string> | undefined => {
  if (!isRecord(value)) return undefined
  const result: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") return undefined
    result[key] = entry
  }
  return result
}

const parseConfigPatch = (content: string): Partial<JcfConfig> => {
  const parsed: unknown = JSON.parse(content)
  if (!isRecord(parsed)) return {}
  const projectMap = stringRecord(parsed.projectMap)
  return {
    ...(typeof parsed.defaultJql === "string" ? { defaultJql: parsed.defaultJql } : {}),
    ...(typeof parsed.refreshInterval === "number" ? { refreshInterval: parsed.refreshInterval } : {}),
    ...(projectMap !== undefined ? { projectMap } : {}),
    ...(typeof parsed.workspaceId === "string" || parsed.workspaceId === null
      ? { workspaceId: parsed.workspaceId }
      : {}),
    ...(typeof parsed.defaultProjectId === "string" || parsed.defaultProjectId === null
      ? { defaultProjectId: parsed.defaultProjectId }
      : {}),
    ...(typeof parsed.defaultProjectName === "string" || parsed.defaultProjectName === null
      ? { defaultProjectName: parsed.defaultProjectName }
      : {}),
    ...(typeof parsed.defaultBillable === "boolean" ? { defaultBillable: parsed.defaultBillable } : {})
  }
}

export const layer = Layer.effect(
  ConfigService,
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const home = (yield* HomeDirectory).path
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
        try: () => parseConfigPatch(content),
        catch: () => ({})
      })
      return { ...defaultConfig, ...parsed }
    }).pipe(Effect.catch(() => Effect.succeed(defaultConfig)))

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
        }).pipe(Effect.catch(() => Effect.void)),
      configDir: Effect.succeed(dir)
    }
  })
)
