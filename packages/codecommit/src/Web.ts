/**
 * `codecommit web` reuses a running listener before starting one. The owner's control token stays
 * in the private control file; fresh one-time URLs go only to stdout and the browser opener.
 * Reuse exits without touching that server; startup remains foreground until interruption.
 *
 * @module
 */
import { browserLaunch, BrowserLaunchOutputError, openOrServe } from "@knpkv/browser-pairing/launch"
import { isPortTaken, requestLoginUrl, requireLoopbackHostname } from "@knpkv/codecommit-web"
import { Config, Effect, Logger, Option, Stream } from "effect"
import { Command, Flag } from "effect/cli"
import * as Stdio from "effect/Stdio"
import { type ReportedFailure, reportFailure } from "./CliFailure.js"

export const existingLoginUrl = requestLoginUrl.pipe(
  Effect.map(Option.some),
  Effect.catchTag("WebNotRunning", () => Effect.succeed(Option.none<string>())),
  Effect.catchTag("WebLoginRefused", (error) => reportFailure(error.message))
)

/**
 * A taken port with no reachable control file: either another program, or a CodeCommit web server
 * whose control file is missing. Either way it is not reused and no second server starts.
 */
const portTakenMessage = (port: number) =>
  `codecommit web: port ${port} is already in use and no running CodeCommit web answered through its control file. If that is a CodeCommit web server it cannot be reused; stop it, or start a new one with --port.`

/** Preserve non-bind errors while reporting a taken port without widening the command's types. */
const reportBindFailure = <E>(port: number, error: E): Effect.Effect<never, E | ReportedFailure> =>
  isPortTaken(error) ? reportFailure(portTakenMessage(port)) : Effect.fail(error)

/** Listener boundary: supplied by the executable, called only for a newly owned foreground server. */
export type WebServe<E, R> = (
  hostname: string,
  port: number,
  announce: (url: string) => Effect.Effect<void, BrowserLaunchOutputError>
) => Effect.Effect<never, E | BrowserLaunchOutputError, R>

/** Build the web command around its listener boundary, retaining print-only login as a subcommand. */
export const makeWebCommand = <E, R>(serve: WebServe<E, R>) =>
  Command.make(
    "web",
    {
      port: Flag.Int("port").pipe(
        Flag.withDescription("First port when starting; ignored when reusing a server"),
        Flag.withDefault(3000)
      ),
      hostname: Flag.String("hostname").pipe(
        Flag.withDescription("Loopback hostname when starting a server"),
        Flag.withDefault("127.0.0.1")
      ),
      noOpen: Flag.Boolean("no-open").pipe(
        Flag.withDescription("Print the sign-in link without opening a browser"),
        Flag.withDefault(false)
      )
    },
    Effect.fn(function*({ hostname, noOpen, port }) {
      yield* requireLoopbackHostname(hostname)
      const stdio = yield* Stdio.Stdio
      const launch = browserLaunch({
        noOpen,
        browser: Option.getOrUndefined(yield* Config.option(Config.String("BROWSER"))),
        ci: Option.getOrUndefined(yield* Config.option(Config.String("CI"))),
        interactive: yield* stdio.stdoutIsTerminal
      })
      return yield* openOrServe({
        login: existingLoginUrl,
        serve: (announce) =>
          serve(hostname, port, announce).pipe(
            Effect.catch((error) => reportBindFailure(port, error)),
            Effect.catchDefect((defect) =>
              isPortTaken(defect) ? reportFailure(portTakenMessage(port)) : Effect.die(defect)
            )
          ),
        launch
      })
    }, Effect.provideService(Logger.LogToStderr, true))
  ).pipe(
    Command.withDescription("Sign in to the browser UI, starting it when needed"),
    Command.withSubcommands([
      Command.make(
        "login",
        {},
        Effect.fn(function*() {
          const url = yield* requestLoginUrl.pipe(Effect.catch((error) => reportFailure(error.message)))
          const stdio = yield* Stdio.Stdio
          yield* Stream.make(`${url}\n`).pipe(
            Stream.run(stdio.stdout({ endOnDone: false })),
            Effect.mapError(() => new BrowserLaunchOutputError({}))
          )
        }, Effect.provideService(Logger.LogToStderr, true))
      ).pipe(Command.withDescription("Print a fresh one-time sign-in link from the running server"))
    ])
  )
