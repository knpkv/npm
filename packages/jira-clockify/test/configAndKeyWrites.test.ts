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

const CONFIG_PATH = `${FAKE_HOME}/.jcf/config.json`

const denied = (method: string) =>
  Effect.fail(new PlatformError(new SystemError({ _tag: "PermissionDenied", module: "FileSystem", method })))

/** `service` over a home whose files behave as `fs` says. */
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

const corruptConfig: Partial<FileSystem.FileSystem> = {
  exists: () => Effect.succeed(true),
  readFileString: () => Effect.succeed("{ not json")
}

describe("config writes", () => {
  it.layer(withFiles(ConfigLayer)(corruptConfig))("an unreadable config", (it) => {
    it.effect("reads as jcf's defaults, with a warning naming the file", () =>
      Effect.gen(function*() {
        const log = capture()
        const config = yield* ConfigService
        expect(yield* config.get.pipe(Effect.withLogger(log.logger))).toEqual(defaultJcfConfig)
        expect(log.text()).toContain(`Could not read ${CONFIG_PATH}; using jcf's defaults until it is fixed.`)
      }))
  })

  // `set` merges into what the file holds; merging into defaults would overwrite the user's settings.
  const written: Array<string> = []
  it.layer(
    withFiles(ConfigLayer)({
      ...corruptConfig,
      writeFileString: (path) => Effect.sync(() => void written.push(path))
    })
  )("set over an unreadable config", (it) => {
    it.effect("refuses, and writes nothing", () =>
      Effect.gen(function*() {
        const config = yield* ConfigService
        const error = yield* config.set({ defaultBillable: true }).pipe(Effect.flip)
        expect(error._tag).toBe("ConfigUnreadable")
        expect(error.message).toBe(
          `Could not read ${CONFIG_PATH}. Fix or remove it, then try again; nothing was changed.`
        )
        expect(written).toEqual([])
      }))
  })

  it.layer(
    withFiles(ConfigLayer)({
      exists: () => Effect.succeed(true),
      readFileString: () => Effect.succeed("{}"),
      writeFileString: () => denied("writeFileString")
    })
  )("set when the config cannot be written", (it) => {
    it.effect("fails with ConfigNotSaved", () =>
      Effect.gen(function*() {
        const config = yield* ConfigService
        const error = yield* config.set({ defaultBillable: true }).pipe(Effect.flip)
        expect(error._tag).toBe("ConfigNotSaved")
        expect(error.message).toBe(`Could not save ${CONFIG_PATH}. Check that the folder is writable.`)
      }))
  })
})

describe("Clockify key writes", () => {
  it.layer(
    withFiles(ClockifyAuthLayer)({
      exists: () => Effect.succeed(true),
      writeFileString: () => Effect.void,
      chmod: () => denied("chmod")
    })
  )("save when the key cannot be made owner-only", (it) => {
    it.effect("fails with ClockifyKeyNotSaved", () =>
      Effect.gen(function*() {
        const auth = yield* ClockifyAuth
        const error = yield* auth.save({ apiKey: "key", workspaceId: "ws", userId: "user" }).pipe(Effect.flip)
        expect(error._tag).toBe("ClockifyKeyNotSaved")
      }))
  })
})
