/**
 * Cross-platform browser launcher backed by Effect child process services.
 *
 * Tries `open`, then `xdg-open`, then `rundll32.exe`, stopping at the first that
 * exits 0. A launcher that is missing or exits non-zero falls through to the next;
 * when none succeeds the last failure is reported, typed, so the caller decides
 * whether a browser that never opened is fatal.
 *
 * @module
 */
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import type * as PlatformError from "effect/PlatformError"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

/** A launcher ran but reported failure (for example `xdg-open` with no browser on a headless host). */
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
      return yield* new BrowserOpenError({ command, exitCode })
    }
  })

/** Open `url` in the user's browser. */
export const openBrowser = (
  url: string
): Effect.Effect<void, BrowserOpenError | PlatformError.PlatformError, ChildProcessSpawner.ChildProcessSpawner> =>
  run("open", [url]).pipe(
    Effect.catch(() => run("xdg-open", [url])),
    Effect.catch(() => run("rundll32.exe", ["url.dll,FileProtocolHandler", url]))
  )
