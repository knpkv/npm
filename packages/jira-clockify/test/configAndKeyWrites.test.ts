/**
 * Writes that used to report success when they failed, and reads that used to fall back without a word.
 */
import { describe, expect, it } from "@effect/vitest"
import { FileSystem, Layer, Path } from "effect"
import * as Effect from "effect/Effect"
import * as Logger from "effect/Logger"
import { PlatformError, SystemError } from "effect/PlatformError"
import { ClockifyAuth, layer as ClockifyAuthLayer } from "../src/services/ClockifyAuth.js"
import { ConfigService, defaultJcfConfig, layer as ConfigLayer } from "../src/services/ConfigService.js"
import { HomeDirectory } from "../src/services/HomeDirectory.js"
import { FAKE_HOME } from "../src/testing/fakeHeadless.js"

// A test case is its own entry point: it composes exactly the layers that case needs and provides them there.
// @effect-diagnostics strictEffectProvide:off

const CONFIG_PATH = `${FAKE_HOME}/.jcf/config.json`

const denied = (method: string) =>
  Effect.fail(new PlatformError(new SystemError({ _tag: "PermissionDenied", module: "FileSystem", method })))

const withFiles = <S>(service: Layer.Layer<S, never, FileSystem.FileSystem | Path.Path | HomeDirectory>) =>
(
  fs: Partial<FileSystem.FileSystem>
) =>
  service.pipe(
    Layer.provide(Layer.succeed(HomeDirectory, { path: FAKE_HOME })),
    Layer.provide(Path.layer),
    Layer.provide(FileSystem.layerNoop(fs))
  )

const capture = () => {
  const messages: Array<unknown> = []
  return {
    logger: Logger.make<unknown, void>((entry) => {
      messages.push(entry.message)
    }),
    text: () => messages.map(String).join("\n")
  }
}

describe("config writes", () => {
  it.effect("an unreadable config reads as jcf's defaults, with a warning naming the file", () =>
    Effect.gen(function*() {
      const log = capture()
      const config = yield* ConfigService
      expect(yield* config.get.pipe(Effect.withLogger(log.logger))).toEqual(defaultJcfConfig)
      expect(log.text()).toContain(`Could not read ${CONFIG_PATH}; using jcf's defaults until it is fixed.`)
    }).pipe(Effect.provide(
      withFiles(ConfigLayer)({
        exists: () => Effect.succeed(true),
        readFileString: () => Effect.succeed("{ not json")
      })
    )))

  // `set` merges into what the file holds; merging into defaults would overwrite the user's settings.
  it.effect("set refuses to change an unreadable config, and writes nothing", () => {
    const written: Array<string> = []
    return Effect.gen(function*() {
      const config = yield* ConfigService
      const error = yield* config.set({ defaultBillable: true }).pipe(Effect.flip)
      expect(error._tag).toBe("ConfigUnreadable")
      expect(error.message).toBe(
        `Could not read ${CONFIG_PATH}. Fix or remove it, then try again; nothing was changed.`
      )
      expect(written).toEqual([])
    }).pipe(Effect.provide(
      withFiles(ConfigLayer)({
        exists: () => Effect.succeed(true),
        readFileString: () => Effect.succeed("{ not json"),
        writeFileString: (path) => Effect.sync(() => void written.push(path))
      })
    ))
  })

  it.effect("set fails when the new config cannot be written", () =>
    Effect.gen(function*() {
      const config = yield* ConfigService
      const error = yield* config.set({ defaultBillable: true }).pipe(Effect.flip)
      expect(error._tag).toBe("ConfigNotSaved")
      expect(error.message).toBe(`Could not save ${CONFIG_PATH}. Check that the folder is writable.`)
    }).pipe(Effect.provide(
      withFiles(ConfigLayer)({
        exists: () => Effect.succeed(true),
        readFileString: () => Effect.succeed("{}"),
        writeFileString: () => denied("writeFileString")
      })
    )))
})

describe("Clockify key writes", () => {
  it.effect("save fails when the key cannot be made owner-only", () =>
    Effect.gen(function*() {
      const auth = yield* ClockifyAuth
      const error = yield* auth.save({ apiKey: "key", workspaceId: "ws", userId: "user" }).pipe(Effect.flip)
      expect(error._tag).toBe("ClockifyKeyNotSaved")
    }).pipe(Effect.provide(
      withFiles(ClockifyAuthLayer)({
        exists: () => Effect.succeed(true),
        writeFileString: () => Effect.void,
        chmod: () => denied("chmod")
      })
    )))
})
