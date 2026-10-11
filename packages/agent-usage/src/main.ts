#!/usr/bin/env node
/**
 * `agent-usage` — record Claude and Codex usage on this Machine and show it in a browser.
 *
 * - `agent-usage [--no-open] [--port N]` signs in to the running server or starts a foreground
 *   server, opens the browser, and prints the link. A reused server keeps running unchanged.
 * - `agent-usage serve` ingests every minute, polls Claude limits every five, and prints the URL
 *   that gets you in.
 * - `agent-usage login [--open]` asks the running server for a fresh one-time link and prints it.
 * - `agent-usage ingest [--json]` runs one ingest pass and reports what it found.
 * - `agent-usage limits` asks the running server for this Machine's latest limits, as one JSON line.
 * - `agent-usage usage [--range 24h|7d|30d] [--time-zone ZONE]` asks it for this Machine's tokens per
 *   period, agent and model, and its limit series over the range, as one JSON line.
 *
 * @module
 */
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { browserLaunch, BrowserOpener, openOrServe } from "@knpkv/browser-pairing/launch"
import { loopbackOrigin, serveWithBootstrapUrl } from "@knpkv/browser-pairing/owner-session"
import { Config, ConfigProvider, Console, Effect, Layer, Logger, Option, Schema } from "effect"
import { Command, Flag } from "effect/cli"
import * as Stdio from "effect/Stdio"
import * as Stream from "effect/Stream"
import { hostname, userInfo } from "node:os"
// Read at run time from the package.json this file ships next to (`dist/../package.json`).
import pkg from "../package.json" with { type: "json" }
import { databaseLayer } from "./core/Database.js"
import { ingestOnce, type IngestStatus } from "./core/Ingest.js"
import { loadConfig } from "./server/Config.js"
import { describeIngest } from "./server/IngestSummary.js"
import { limits as requestLimits } from "./server/Limits.js"
import { existingLoginUrl, login as requestLogin } from "./server/Login.js"
import { makeOwnerSession } from "./server/OwnerSession.js"
import { makeServer, Port, PublicOrigin } from "./server/Server.js"
import { usage as requestUsage } from "./server/Usage.js"
import { IngestStatus as IngestStatusSchema, type UsagePreset } from "./shared/contracts.js"

/** The operating system's name for the user; Claude Code's own fallback when it cannot ask. */
const osUserName = (): string => {
  try {
    return userInfo().username
  } catch {
    return "claude-code-user"
  }
}

// Empty values kept, for the one variable where an empty value means something.
const config = loadConfig(hostname(), ConfigProvider.fromEnv({ preserveEmptyStrings: true }), osUserName())

/** The same foreground server for root launch and print-only service startup. */
const serveUsage = Effect.fn("AgentUsage.serve")(function*<E, R>(
  chosenPort: Option.Option<number>,
  announce: (url: string) => Effect.Effect<void, E, R>
) {
  const settings = yield* config
  const port = Option.isSome(chosenPort) ? chosenPort.value : yield* Port
  const configuredOrigin = yield* PublicOrigin
  const security = yield* makeOwnerSession(
    loopbackOrigin("127.0.0.1", port),
    Option.getOrUndefined(configuredOrigin)
  )
  return yield* serveWithBootstrapUrl(
    (ready) => makeServer({ config: settings, port, ready, security }),
    announce
  )
})

const serve = Command.make(
  "serve",
  {},
  Effect.fn(function*() {
    const stdio = yield* Stdio.Stdio
    return yield* serveUsage(
      Option.none(),
      // On stdout and nowhere else: this line is the credential, so it is never logged.
      (url) => Stream.make(`agent usage: ${url}\n`).pipe(Stream.run(stdio.stdout()))
    )
  })
).pipe(Command.withDescription("Record usage continuously and serve the browser view"))

const encodeStatus = Schema.encodeSync(Schema.fromJsonString(IngestStatusSchema))

const ingest = Command.make(
  "ingest",
  {
    json: Flag.Boolean("json").pipe(Flag.withDescription("Print the status as one JSON value"), Flag.withDefault(false))
  },
  Effect.fn(function*({ json }) {
    const settings = yield* config
    const status: IngestStatus = yield* ingestOnce(settings.roots).pipe(
      // This subcommand's entry point: the store opens for this one pass and closes with it.
      // @effect-diagnostics-next-line strictEffectProvide:off
      Effect.provide(databaseLayer(settings.storeDirectory))
    )
    if (json) return yield* Console.log(encodeStatus(status))
    for (const line of describeIngest(status)) yield* Console.log(line)
  })
).pipe(Command.withDescription("Run one ingest pass and report what it found"))

const login = Command.make(
  "login",
  {
    open: Flag.Boolean("open").pipe(Flag.withDescription("Open the link in the browser too"), Flag.withDefault(false))
  },
  // The user id `login` trusts the socket to belong to; -1 (no POSIX ids) matches no owner.
  ({ open }) => requestLogin(config, open, process.geteuid?.() ?? -1)
).pipe(Command.withDescription("Print a fresh one-time link to the running server"))

const limits = Command.make(
  "limits",
  {},
  // The same owner check as `login`: the socket must belong to the user this runs as.
  () => requestLimits(config, process.geteuid?.() ?? -1)
).pipe(Command.withDescription("Print this Machine's latest limits from the running server, as JSON"))

/** A week by day: the Usage tab's default too. */
const defaultUsageRange: UsagePreset = "7d"

const usage = Command.make(
  "usage",
  {
    range: Flag.Literals("range", ["24h", "7d", "30d"]).pipe(
      Flag.withDescription("The last 24 hours by hour, or the last 7 or 30 local days by day"),
      Flag.withDefault(defaultUsageRange)
    ),
    timeZone: Flag.String("time-zone").pipe(
      Flag.withDescription("The IANA zone the periods are local to; defaults to this Machine's"),
      Flag.optional
    )
  },
  // The same owner check as `login`; periods are local to the asker's zone, else this Machine's.
  ({ range, timeZone }) =>
    requestUsage(
      config,
      process.geteuid?.() ?? -1,
      range,
      Option.getOrElse(timeZone, () => Intl.DateTimeFormat().resolvedOptions().timeZone)
    )
).pipe(Command.withDescription("Print this Machine's tokens per model and limit series over a range, as JSON"))

const cli = Command.make(
  "agent-usage",
  {
    noOpen: Flag.Boolean("no-open").pipe(
      Flag.withDescription("Print the sign-in link without opening a browser"),
      Flag.withDefault(false)
    ),
    port: Flag.Int("port").pipe(
      Flag.withDescription(
        "Port when starting a server (overrides PORT or 3112); ignored when reusing a running server"
      ),
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
    return yield* openOrServe({
      login: existingLoginUrl(config, process.geteuid?.() ?? -1),
      serve: (onReady) => serveUsage(port, onReady),
      launch
    })
  })
).pipe(
  Command.withDescription("Claude and Codex subscription usage over time, per ticket and against limits"),
  Command.withSubcommands([serve, login, ingest, limits, usage]),
  Command.run({ version: pkg.version })
)

// Executable entry point: the host platform is provided once for this process.
const runtime = Layer.mergeAll(
  NodeServices.layer,
  BrowserOpener.layer.pipe(Layer.provide(NodeServices.layer)),
  // Shared opener warnings belong on stderr, leaving stdout for the credential and CLI data.
  Layer.succeed(Logger.LogToStderr, true)
)
NodeRuntime.runMain(cli.pipe(Effect.provide(runtime)))
