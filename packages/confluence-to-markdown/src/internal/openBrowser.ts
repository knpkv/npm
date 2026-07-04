/**
 * Cross-platform browser launcher backed by Effect child process services.
 *
 * @internal
 */
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import type * as PlatformError from "effect/PlatformError"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"

export class BrowserOpenError extends Data.TaggedError("BrowserOpenError")<{
  readonly command: string
  readonly exitCode: number
}> {}

const run = (
  command: string,
  args: ReadonlyArray<string>
): Effect.Effect<void, BrowserOpenError | PlatformError.PlatformError, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function*() {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const exitCode = yield* spawner.exitCode(
      ChildProcess.make(command, args, {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore"
      })
    )
    if (exitCode !== 0) {
      return yield* Effect.fail(new BrowserOpenError({ command, exitCode }))
    }
  })

export const openBrowser = (
  url: string
): Effect.Effect<void, BrowserOpenError | PlatformError.PlatformError, ChildProcessSpawner.ChildProcessSpawner> =>
  run("open", [url]).pipe(
    Effect.catch(() => run("xdg-open", [url])),
    Effect.catch(() => run("rundll32.exe", ["url.dll,FileProtocolHandler", url]))
  )
