/**
 * Relay runs only on the canonical tailnet HTTPS listener. Discovery reads existing fleet
 * configuration and public manifests; it never starts hostd or mints browser credentials.
 *
 * @module
 */
import { browserLaunch, BrowserLaunchOutputError, openBrowser, skippedLine } from "@knpkv/browser-pairing/launch"
import { decodeBoundedResponseJson, type HostConfiguration, loadConfiguration } from "@knpkv/herdr-fleet"
import { make as makeTailscale, resolveFleetNode } from "@knpkv/herdr-tailscale"
import { Config, Context, Data, Effect, Layer, Logger, Option, Runtime, Schema, Stream } from "effect"
import { Command, Flag } from "effect/cli"
import { HttpClient } from "effect/http"
import { ChildProcessSpawner } from "effect/process"
import * as Stdio from "effect/Stdio"
import { fleetConfigPath } from "./config-path.js"

const Manifest = Schema.Struct({
  id: Schema.Literal("/"),
  name: Schema.Literal("Relay"),
  start_url: Schema.Literal("/")
})

/** Read-only network observations. Failed, timed-out or malformed probes mean unreachable. */
export class RelayProbe extends Context.Service<RelayProbe, {
  readonly tailnetOnline: (config: HostConfiguration) => Effect.Effect<boolean>
  readonly answers: (url: string) => Effect.Effect<boolean>
}>()("@knpkv/herdr-hub/RelayProbe") {
  static readonly layer = Layer.effect(
    RelayProbe,
    Effect.gen(function*() {
      const client = yield* HttpClient.HttpClient
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const tailnetOnline = Effect.fn("RelayProbe.tailnetOnline")(
        function*(config: HostConfiguration) {
          const tailscale = yield* makeTailscale(config.tailscaleCommand).pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner)
          )
          const status = yield* tailscale.status
          if (!status.Self.Online || status.Self.TailscaleIPs.length === 0) return false
          const hub = yield* resolveFleetNode(status, config.approvalHub)
          return hub.Online && hub.TailscaleIPs.length > 0
        },
        Effect.catchTag([
          "HerdrTailscale.CommandError",
          "HerdrTailscale.DecodeError",
          "HerdrTailscale.FleetIdentityError"
        ], () => Effect.succeed(false)),
        Effect.timeoutOption("1 second"),
        Effect.map(Option.getOrElse(() => false))
      )
      // The executable supplies NodeHttpClient.layerNodeHttp, which does not follow redirects.
      const answers = Effect.fn("RelayProbe.answers")(
        function*(url: string) {
          const response = yield* client.get(new URL("/manifest.webmanifest", url).href)
          if (response.status !== 200) return false
          yield* decodeBoundedResponseJson(response, Manifest, 4096)
          return true
        },
        Effect.catchTag(["HttpClientError", "FleetResponseBodyError"], () => Effect.succeed(false)),
        Effect.timeoutOption("1 second"),
        Effect.map(Option.getOrElse(() => false))
      )
      return RelayProbe.of({ tailnetOnline, answers })
    })
  )
}

type RelayTarget = Data.TaggedEnum<{
  Open: { readonly url: string }
  DashboardOnly: { readonly url: string }
  NotRunning: {}
}>
const RelayTarget = Data.taggedEnum<RelayTarget>()

/** Prefer the canonical hub; the local dashboard is an error hint, never an open target. */
export const decideRelayTarget = (tailnet: Option.Option<string>, local: Option.Option<string>): RelayTarget =>
  Option.isSome(tailnet) ?
    RelayTarget.Open({ url: tailnet.value })
    : Option.isSome(local) ?
    RelayTarget.DashboardOnly({ url: local.value })
    : RelayTarget.NotRunning()

const discover = Effect.fn("Relay.discover")(function*(config: HostConfiguration) {
  const probe = yield* RelayProbe
  if ((yield* probe.tailnetOnline(config)) && (yield* probe.answers(config.approvalHub.url))) {
    return decideRelayTarget(Option.some(config.approvalHub.url), Option.none())
  }
  const local = `http://127.0.0.1:${config.localPort}/`
  return decideRelayTarget(Option.none(), (yield* probe.answers(local)) ? Option.some(local) : Option.none())
})

/** A failure already printed on stderr; NodeRuntime exits nonzero without a second error report. */
export class RelayOpenFailed extends Schema.TaggedError<RelayOpenFailed>()("RelayOpenFailed", {}) {
  override readonly [Runtime.errorReported] = false
}
class RelayOutputError extends Schema.TaggedError<RelayOutputError>()("RelayOutputError", {}) {
  override readonly message = "Could not print the Relay launch result"
}

/** Root launch handler only; subcommands and help retain their own behavior. */
export const relayRootCommand = Command.make(
  "relay",
  {
    noOpen: Flag.Boolean("no-open").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Print the Relay URL without opening a browser")
    )
  },
  Effect.fn("Relay.open")(function*({ noOpen }) {
    const config = yield* loadConfiguration(yield* fleetConfigPath)
    const target = yield* discover(config)
    const stdio = yield* Stdio.Stdio
    if (target._tag !== "Open") {
      const message = target._tag === "DashboardOnly"
        ? `Relay is only served over the tailnet (hub not reachable); this machine's dashboard is at ${target.url}`
        : "hostd is not running. Start it with: systemctl --user start hostd"
      yield* Stream.make(`${message}\n`).pipe(
        Stream.run(stdio.stderr({ endOnDone: false })),
        Effect.mapError(() => new RelayOutputError({}))
      )
      return yield* new RelayOpenFailed({})
    }
    const launch = browserLaunch({
      noOpen,
      browser: Option.getOrUndefined(yield* Config.option(Config.String("BROWSER"))),
      ci: Option.getOrUndefined(yield* Config.option(Config.String("CI"))),
      interactive: yield* stdio.stdoutIsTerminal
    })
    yield* Stream.make(`${target.url}\n`).pipe(
      Stream.run(stdio.stdout({ endOnDone: false })),
      Effect.mapError(() => new BrowserLaunchOutputError({}))
    )
    if (launch._tag === "Skip") {
      yield* Stream.make(`${skippedLine(launch.reason)}\n`).pipe(
        Stream.run(stdio.stdout({ endOnDone: false })),
        Effect.mapError(() => new BrowserLaunchOutputError({}))
      )
    } else yield* openBrowser(target.url)
  }, Effect.provideService(Logger.LogToStderr, true))
).pipe(Command.withDescription("Open Relay on the tailnet"))
