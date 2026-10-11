/**
 * Browser-launch policy and foreground server orchestration. Callers supply
 * terminal/environment observations and obtain URLs through their existing
 * login or owner-session flow. URLs may carry credentials: stdout and the
 * browser opener are their only output boundaries.
 *
 * @module
 */
import { Context, Effect, Layer, Option, Result, Schema, Stream } from "effect"
import * as ChildProcess from "effect/process/ChildProcess"
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner"
import type * as Scope from "effect/Scope"
import * as Stdio from "effect/Stdio"

export type BrowserLaunch =
  | { readonly _tag: "Open" }
  | { readonly _tag: "Skip"; readonly reason: string }

export interface BrowserLaunchInput {
  /** `--no-open` was passed. */
  readonly noOpen: boolean
  /** `BROWSER`, when set. */
  readonly browser: string | undefined
  /** `CI`, when set. Empty, `0` and `false` mean not CI. */
  readonly ci: string | undefined
  /** stdout is a terminal. Read this at the executable boundary. */
  readonly interactive: boolean
}

const skip = (reason: string): BrowserLaunch => ({ _tag: "Skip", reason })

const isSetFlag = (value: string | undefined): boolean =>
  value !== undefined && !["", "0", "false"].includes(value.trim().toLowerCase())

/** Decide whether to open a browser, preserving the first applicable skip reason. */
export const browserLaunch = (input: BrowserLaunchInput): BrowserLaunch => {
  if (input.noOpen) return skip("--no-open")
  if (input.browser?.trim().toLowerCase() === "none") return skip("BROWSER=none")
  if (isSetFlag(input.ci)) return skip("CI is set")
  if (!input.interactive) return skip("not an interactive terminal")
  return { _tag: "Open" }
}

/** The line printed instead of opening a browser. */
export const skippedLine = (reason: string): string => `Not opening a browser (${reason}); open the link above.`

/** Sanitized failure: subprocess errors may contain a credential-bearing URL. */
export class BrowserOpenError extends Schema.TaggedError<BrowserOpenError>()("BrowserOpenError", {}) {
  override readonly message = "No browser could be opened; open the link above"
}

/** Sanitized stdout failure: never attach the URL or the underlying write error. */
export class BrowserLaunchOutputError extends Schema.TaggedError<BrowserLaunchOutputError>()(
  "BrowserLaunchOutputError",
  {}
) {
  override readonly message = "Could not print the browser link to stdout"
}

/** Injectable browser opener. The live layer owns only each short-lived opener process. */
export class BrowserOpener extends Context.Service<BrowserOpener, {
  readonly open: (url: string) => Effect.Effect<void, BrowserOpenError>
}>()("@knpkv/browser-pairing/BrowserOpener") {
  static readonly layer = Layer.effect(
    BrowserOpener,
    Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      // In this process's group, not one of its own: an opener's group is killed when it is reaped,
      // which would take the browser it just started with it. Output is ignored so a browser that
      // inherits it cannot hold this process open.
      const options = {
        detached: false,
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore"
      } satisfies ChildProcess.CommandOptions
      const open = Effect.fn("BrowserOpener.open")(function*(url: string) {
        const commands = [
          ChildProcess.make("open", [url], options),
          ChildProcess.make("xdg-open", [url], options),
          ChildProcess.make("rundll32.exe", ["url.dll,FileProtocolHandler", url], options)
        ]
        for (const command of commands) {
          // Preserve the existing policy: retry process failures, not numeric exit codes.
          const result = yield* Effect.result(spawner.exitCode(command))
          if (Result.isSuccess(result)) return
        }
        return yield* new BrowserOpenError({})
      })
      return BrowserOpener.of({ open })
    })
  )
}

/** Best effort after the URL is printed; the warning contains no subprocess error or URL. */
export const openBrowser = Effect.fn("BrowserLaunch.openBrowser")(function*(url: string) {
  const opener = yield* BrowserOpener
  yield* opener.open(url).pipe(
    Effect.catchTag("BrowserOpenError", () => Effect.logWarning("No browser could be opened; open the link above"))
  )
})

export interface OpenOrServeOptions<LoginError, LoginServices, ServeError, ServeServices> {
  /**
   * Return an existing server's URL, with or without a credential. Only `None`
   * means no server is available; failures propagate without starting another.
   */
  readonly login: Effect.Effect<Option.Option<string>, LoginError, LoginServices>
  /**
   * Start a foreground server, call `onReady` only after listening, then remain
   * alive until interruption. Scoped resources are released when the run ends.
   * Browser-tab closure and idle time must not stop the server.
   */
  readonly serve: (
    onReady: (url: string) => Effect.Effect<void, BrowserLaunchOutputError>
  ) => Effect.Effect<never, ServeError, ServeServices>
  readonly launch: BrowserLaunch
}

/**
 * Print/open an existing server's URL and return, leaving that server untouched.
 * Otherwise run `serve` in a scope and print/open its ready URL once. Executables
 * use their runtime's SIGINT/SIGTERM handling to interrupt the foreground run.
 * URLs are printed only to stdout; caller-provided login/serve effects must
 * likewise keep credential URLs out of errors, logs, and telemetry.
 */
export const openOrServe = Effect.fn("BrowserLaunch.openOrServe")(function*<
  LoginError,
  LoginServices,
  ServeError,
  ServeServices
>(options: OpenOrServeOptions<LoginError, LoginServices, ServeError, ServeServices>): Effect.fn.Return<
  void,
  LoginError | ServeError | BrowserLaunchOutputError,
  LoginServices | Exclude<ServeServices, Scope.Scope> | BrowserOpener | Stdio.Stdio
> {
  const existing = yield* options.login
  const stdio = yield* Stdio.Stdio
  const opener = yield* BrowserOpener
  const announce = Effect.fnUntraced(function*(url: string) {
    yield* Stream.make(`${url}\n`).pipe(
      Stream.run(stdio.stdout({ endOnDone: false })),
      Effect.mapError(() => new BrowserLaunchOutputError({}))
    )
    if (options.launch._tag === "Skip") {
      yield* Stream.make(`${skippedLine(options.launch.reason)}\n`).pipe(
        Stream.run(stdio.stdout({ endOnDone: false })),
        Effect.mapError(() => new BrowserLaunchOutputError({}))
      )
    } else {
      yield* openBrowser(url).pipe(Effect.provideService(BrowserOpener, opener))
    }
  })
  if (Option.isSome(existing)) return yield* announce(existing.value)
  return yield* Effect.scoped(Effect.suspend(() => options.serve(announce)))
})
