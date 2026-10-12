/**
 * The week-view executable commands: reuse a running server before starting one, and keep service
 * starts and print-only login available. Sign-in URLs and control tokens are credentials; URL output
 * belongs on stdout, while failures belong on stderr.
 *
 * @module
 */
import { makeWebControl } from "@knpkv/browser-pairing/control"
import { browserLaunch, BrowserLaunchOutputError, openOrServe } from "@knpkv/browser-pairing/launch"
import { WebControl } from "@knpkv/jira-clockify"
import { Config, Console, Data, Effect, Option, Path, Runtime } from "effect"
import { Command, Flag } from "effect/cli"
import * as Stdio from "effect/Stdio"
import * as Stream from "effect/Stream"

/** A failure already printed as its one line; the process exits nonzero without a stack. */
export class Reported extends Data.TaggedError("Reported")<{}> {
  override readonly [Runtime.errorReported] = false
}

const reported = (error: WebControl.WebNotRunning | WebControl.WebLoginRefused) =>
  Console.error(error.message).pipe(Effect.andThen(Effect.fail(new Reported())))

/** Only an absent or unreachable server permits startup; a refused login remains a failure. */
export const existingLoginUrl = WebControl.requestLoginUrl.pipe(
  Effect.map(Option.some),
  Effect.catchTag("WebNotRunning", () => Effect.succeed(Option.none<string>())),
  Effect.catchTag("WebLoginRefused", reported)
)

/** Foreground listener boundary, called only when this invocation owns the new server. */
export type WeekViewServe<E, R> = (
  port: Option.Option<number>,
  onReady: (url: string) => Effect.Effect<void, BrowserLaunchOutputError>
) => Effect.Effect<never, E | BrowserLaunchOutputError, R>

/**
 * Announce the credential-bearing URL after listening, then publish the owner-only control token.
 * Remove only this server's control file when its foreground scope ends.
 */
export const announceWeekView = Effect.fn("JcfWeb.announceWeekView")(function*<E, R>(
  origin: string,
  token: string,
  url: string,
  announce: (url: string) => Effect.Effect<void, E, R>
) {
  yield* announce(url)
  const path = yield* Path.Path
  const file = yield* WebControl.controlFilePath
  yield* makeWebControl({ directory: path.dirname(file), file }).registerControlFile({ origin, token }).pipe(
    Effect.catchTag("ControlFileError", () => Console.error(new WebControl.ControlFileError({ path: file }).message))
  )
})

/** The service start's announcement: the labelled URL on stdout and nowhere else. */
const printWeekView = (stdio: Stdio.Stdio) => (url: string) =>
  Stream.make(`jcf week view: ${url}\n`).pipe(
    Stream.run(stdio.stdout({ endOnDone: false })),
    Effect.mapError(() => new BrowserLaunchOutputError({}))
  )

/** Build the executable commands around the application's foreground listener boundary. */
export const makeCommand = <E, R>(serve: WeekViewServe<E, R>) =>
  Command.make(
    "jcf-web",
    {
      noOpen: Flag.Boolean("no-open").pipe(
        Flag.withDescription("Print the sign-in link without opening a browser"),
        Flag.withDefault(false)
      ),
      port: Flag.Int("port").pipe(
        Flag.withDescription("Port when starting a server (overrides PORT or 3111); ignored when reusing a server"),
        Flag.optional
      )
    },
    Effect.fn(function*({ noOpen, port }) {
      const stdio = yield* Stdio.Stdio
      const launch = browserLaunch({
        noOpen,
        browser: Option.getOrUndefined(yield* Config.option(Config.String("BROWSER"))),
        ci: Option.getOrUndefined(yield* Config.option(Config.String("CI"))),
        interactive: yield* stdio.stdoutIsTerminal
      })
      return yield* openOrServe({ login: existingLoginUrl, serve: (onReady) => serve(port, onReady), launch })
    })
  ).pipe(
    Command.withDescription("Sign in to the Jira and Clockify week view, starting it when needed"),
    Command.withSubcommands([
      Command.make(
        "serve",
        {},
        () => Effect.flatMap(Stdio.Stdio, (stdio) => serve(Option.none(), printWeekView(stdio)))
      ).pipe(
        Command.withDescription("Start the week view in the foreground and print its sign-in link")
      ),
      Command.make("login", {}, () =>
        WebControl.requestLoginUrl.pipe(
          Effect.flatMap((url) => Console.log(`jcf week view: ${url}`)),
          Effect.catch(reported)
        )).pipe(Command.withDescription("Print a fresh one-time sign-in link from the running week view"))
    ])
  )
