/**
 * Settings service for browse TUI - persists to ~/.config/confluence-to-markdown/browse.json
 */
import * as FileSystem from "@effect/platform/FileSystem"
import * as Path from "@effect/platform/Path"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { defaultTheme, type ThemeName, themeNames } from "./themes/index.js"

/**
 * Settings schema
 */
const SettingsSchema = Schema.Struct({
  theme: Schema.String.pipe(
    Schema.filter((s): s is ThemeName => themeNames.includes(s as ThemeName))
  )
})

export type Settings = Schema.Schema.Type<typeof SettingsSchema>

const defaultSettings: Settings = {
  theme: defaultTheme
}

/**
 * Service interface for browse settings.
 */
export interface BrowseSettings {
  readonly get: Effect.Effect<Settings>
  readonly setTheme: (theme: ThemeName) => Effect.Effect<void>
  readonly getConfigPath: Effect.Effect<string>
}

export const BrowseSettings = Context.GenericTag<BrowseSettings>("@knpkv/confluence-to-markdown/BrowseSettings")

/**
 * Live implementation using filesystem.
 */
export const BrowseSettingsLive = Layer.effect(
  BrowseSettings,
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path

    const homeDir = process.env.HOME ?? process.env.USERPROFILE ?? "~"
    const configDir = path.join(homeDir, ".config", "confluence-to-markdown")
    const configFile = path.join(configDir, "browse.json")

    const ensureConfigDir = Effect.gen(function*() {
      const exists = yield* fs.exists(configDir)
      if (!exists) {
        yield* fs.makeDirectory(configDir, { recursive: true })
      }
    })

    const readSettings = Effect.gen(function*() {
      const exists = yield* fs.exists(configFile)
      if (!exists) {
        return defaultSettings
      }
      const content = yield* fs.readFileString(configFile)
      const parsed = JSON.parse(content)
      const decoded = Schema.decodeUnknownSync(SettingsSchema)(parsed)
      return decoded
    }).pipe(
      Effect.catchAll(() => Effect.succeed(defaultSettings))
    )

    const writeSettings = (settings: Settings) =>
      Effect.gen(function*() {
        yield* ensureConfigDir
        yield* fs.writeFileString(configFile, JSON.stringify(settings, null, 2))
      })

    return BrowseSettings.of({
      getConfigPath: Effect.succeed(configFile),

      get: readSettings,

      setTheme: (theme) =>
        Effect.gen(function*() {
          const current = yield* readSettings
          yield* writeSettings({ ...current, theme })
        }).pipe(Effect.catchAll(() => Effect.void))
    })
  })
)
