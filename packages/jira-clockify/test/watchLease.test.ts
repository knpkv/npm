import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Logger from "effect/Logger"
import * as Path from "effect/Path"
import { PlatformError, SystemError } from "effect/PlatformError"
import { acquire } from "../src/cli/watchLease.js"
import { ConfigService, defaultJcfConfig } from "../src/services/ConfigService.js"

const configDir = "/tmp/.jcf-watch-lease-test"

const cursorReadFails = (tag: "NotFound" | "PermissionDenied") =>
  Layer.mergeAll(
    FileSystem.layerNoop({
      makeDirectory: () => Effect.void,
      writeFileString: () => Effect.void,
      readFileString: (path) =>
        Effect.fail(
          new PlatformError(
            new SystemError({ _tag: tag, module: "FileSystem", method: "readFileString", pathOrDescriptor: path })
          )
        )
    }),
    Path.layer,
    Layer.succeed(ConfigService, {
      get: Effect.succeed(defaultJcfConfig),
      set: () => Effect.void,
      configDir: Effect.succeed(configDir),
      fileExists: Effect.succeed(true)
    })
  )

const logsOf = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function*() {
    const logs: Array<{ readonly level: string; readonly message: string }> = []
    const logger = Logger.make<unknown, void>((entry) => {
      logs.push({ level: entry.logLevel, message: String(entry.message) })
    })
    const result = yield* effect.pipe(Effect.withLogger(logger))
    return { logs, result }
  })

// An unreadable resume cursor used to be logged at debug, so a watch silently lost the block it was resuming.
describe("watch lease cursor read", () => {
  it.layer(cursorReadFails("PermissionDenied"))("a cursor that cannot be read", (it) => {
    it.effect("warns that the watch resumes from now, and still takes the lease", () =>
      Effect.gen(function*() {
        const { logs, result } = yield* logsOf(acquire({ intervalSeconds: 60 }))
        expect(result).toMatchObject({ _tag: "Held", resumeFromMs: null })
        const warnings = logs.filter((log) => log.level === "Warn")
        expect(warnings).toHaveLength(1)
        expect(warnings[0]?.message).toContain(
          `Could not read the watch cursor at ${configDir}/watch.cursor; resuming from now`
        )
        expect(warnings[0]?.message).toContain("PermissionDenied")
      }))
  })

  it.layer(cursorReadFails("NotFound"))("no cursor yet", (it) => {
    it.effect("is the first run: no warning", () =>
      Effect.gen(function*() {
        const { logs, result } = yield* logsOf(acquire({ intervalSeconds: 60 }))
        expect(result).toMatchObject({ _tag: "Held", resumeFromMs: null })
        expect(logs.filter((log) => log.level === "Warn")).toEqual([])
      }))
  })
})
