/**
 * Cross-platform browser launcher backed by Effect v4 child process services.
 *
 * @internal
 */
import * as Effect from "effect/Effect"
import type * as PlatformError from "effect/PlatformError"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"

const run = (
  command: string,
  args: ReadonlyArray<string>
): Effect.Effect<void, PlatformError.PlatformError, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function*() {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    yield* spawner.exitCode(
      ChildProcess.make(command, args, {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore"
      })
    )
  })

export const openBrowser = (
  url: string
): Effect.Effect<void, PlatformError.PlatformError, ChildProcessSpawner.ChildProcessSpawner> =>
  run("open", [url]).pipe(
    Effect.catch(() => run("xdg-open", [url])),
    Effect.catch(() => run("rundll32.exe", ["url.dll,FileProtocolHandler", url]))
  )
