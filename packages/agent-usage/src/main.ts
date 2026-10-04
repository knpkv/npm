#!/usr/bin/env node
/**
 * `agent-usage` — record Claude and Codex usage on this Machine and show it in a browser.
 *
 * - `agent-usage serve` ingests every minute, polls Claude limits every five, and prints the URL
 *   that gets you in.
 * - `agent-usage login [--open]` asks the running server for a fresh one-time link and prints it.
 * - `agent-usage ingest [--json]` runs one ingest pass and reports what it found.
 *
 * @module
 */
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { ConfigProvider, Console, Deferred, Effect, Fiber, Layer, Option, Schema } from "effect"
import { Command, Flag } from "effect/cli"
import * as Stdio from "effect/Stdio"
import * as Stream from "effect/Stream"
import { hostname, platform, userInfo } from "node:os"
import { databaseLayer } from "./core/Database.js"
import { ingestOnce, type IngestStatus } from "./core/Ingest.js"
import { loadConfig } from "./server/Config.js"
import { describeIngest } from "./server/IngestSummary.js"
import { login as requestLogin } from "./server/Login.js"
import { makeOwnerSessionSecrets, ownerSessionOrigin } from "./server/OwnerSession.js"
import { makeServer, Port, PublicOrigin } from "./server/Server.js"
import { IngestStatus as IngestStatusSchema } from "./shared/contracts.js"

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

const serve = Command.make(
  "serve",
  {},
  Effect.fn(function*() {
    const stdio = yield* Stdio.Stdio
    const settings = yield* config
    const port = yield* Port
    const configuredOrigin = yield* PublicOrigin
    const security = yield* makeOwnerSessionSecrets(
      ownerSessionOrigin("127.0.0.1", port),
      Option.getOrUndefined(configuredOrigin)
    )
    const ready = yield* Deferred.make<string>()
    const server = yield* Layer.launch(makeServer({ config: settings, port, ready, security })).pipe(
      Effect.forkChild({ startImmediately: true })
    )
    // The server only ends this race by failing; until it is listening there is no link to print.
    const url = yield* Effect.raceFirst(Deferred.await(ready), Fiber.join(server).pipe(Effect.andThen(Effect.never)))
    // On stdout and nowhere else: this line is the credential, so it is never logged.
    yield* Stream.make(`agent usage: ${url}\n`).pipe(
      Stream.run(stdio.stdout())
    )
    return yield* Fiber.join(server)
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
  ({ open }) => requestLogin(config, open, platform())
).pipe(Command.withDescription("Print a fresh one-time link to the running server"))

const cli = Command.make("agent-usage").pipe(
  Command.withDescription("Claude and Codex subscription usage over time, per ticket and against limits"),
  Command.withSubcommands([serve, login, ingest]),
  Command.run({ version: "0.1.0" })
)

// Executable entry point: the host platform is provided once for this process.
NodeRuntime.runMain(cli.pipe(Effect.provide(NodeServices.layer)))
