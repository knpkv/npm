/** @effect-diagnostics strictEffectProvide:skip-file */
/**
 * The launcher order and when it stops. A launcher that is missing or exits
 * non-zero falls through to the next; when none succeeds the failure is typed so
 * the caller decides whether that is fatal.
 */
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as PlatformError from "effect/PlatformError"
import { ChildProcessSpawner } from "effect/process"
import * as Sink from "effect/Sink"
import * as Stream from "effect/Stream"
import { openBrowser } from "../src/cli-auth/index.js"

// `outcomes` maps a launcher to its exit code; a launcher not listed is missing.
const launchers = (outcomes: Readonly<Record<string, number>>, attempts: Array<string>) =>
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      const name = command._tag === "StandardCommand" ? command.command : "piped"
      attempts.push(name)
      const exitCode = outcomes[name]
      if (exitCode === undefined) {
        return Effect.fail(PlatformError.systemError({ _tag: "NotFound", module: "ChildProcess", method: "spawn" }))
      }
      return Effect.succeed(ChildProcessSpawner.makeHandle({
        all: Stream.empty,
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        pid: ChildProcessSpawner.ProcessId(1),
        reref: Effect.void,
        stderr: Stream.empty,
        stdin: Sink.drain,
        stdout: Stream.empty,
        unref: Effect.succeed(Effect.void)
      }))
    })
  )

describe("openBrowser", () => {
  it.effect("stops at the first launcher that exits 0", () =>
    Effect.gen(function*() {
      const attempts: Array<string> = []
      yield* openBrowser("https://example.test").pipe(Effect.provide(launchers({ "xdg-open": 0 }, attempts)))
      expect(attempts).toEqual(["open", "xdg-open"])
    }))

  it.effect("falls through a launcher that exits non-zero", () =>
    Effect.gen(function*() {
      const attempts: Array<string> = []
      yield* openBrowser("https://example.test").pipe(
        Effect.provide(launchers({ open: 1, "xdg-open": 3, "rundll32.exe": 0 }, attempts))
      )
      expect(attempts).toEqual(["open", "xdg-open", "rundll32.exe"])
    }))

  it.effect("fails with the last launcher's exit when none succeeds", () =>
    Effect.gen(function*() {
      const attempts: Array<string> = []
      const error = yield* openBrowser("https://example.test").pipe(
        Effect.provide(launchers({ open: 1, "xdg-open": 4, "rundll32.exe": 2 }, attempts)),
        Effect.flip
      )
      expect(error).toMatchObject({ _tag: "BrowserOpenError", command: "rundll32.exe", exitCode: 2 })
    }))
})
