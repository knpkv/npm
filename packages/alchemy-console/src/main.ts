#!/usr/bin/env node
/** Loopback executable boundary: no-arg/login reuse or start; serve stays foreground and print-only. */
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { browserLaunch, BrowserOpener } from "@knpkv/browser-pairing/launch"
import { Effect, Layer, Schema } from "effect"
import { Command, Flag } from "effect/cli"
import { FetchHttpClient } from "effect/http"
import { homedir } from "node:os"
import process from "node:process"
import { Catalog } from "./server/Catalog.js"
import { loadConfig, Port, readPackageVersion, StartupError } from "./server/Config.js"
import { runConsole } from "./server/Launch.js"
import { configuredPlanLayer } from "./server/PlanReader.js"
import { sourceLayer } from "./server/Sources.js"
import { ssoCredentialsLayer } from "./sso-credentials.js"

const home = homedir()
const uid = process.geteuid?.() ?? -1
const observations = {
  browser: process.env.BROWSER,
  ci: process.env.CI,
  interactive: process.stdout.isTTY === true
}

const flags = {
  port: Flag.Int("port").pipe(Flag.withDefault(3114)),
  noOpen: Flag.Boolean("no-open").pipe(Flag.withDefault(false))
}

const run = Effect.fn("AlchemyConsole.run")(function*(port: number, noOpen: boolean, printOnly: boolean) {
  yield* Schema.decodeUnknownEffect(Port)(port).pipe(
    Effect.mapError(() => new StartupError({ reason: "invalid-port" }))
  )
  const config = yield* loadConfig(home).pipe(Effect.mapError(() => new StartupError({ reason: "config" })))
  const options = { directory: config.directory, port, uid }
  return yield* runConsole(options, browserLaunch({ ...observations, noOpen }), printOnly)
})

const login = Command.make("login", flags, ({ noOpen, port }) => run(port, noOpen, false))
const serve = Command.make("serve", flags, ({ noOpen, port }) => run(port, noOpen, true))
const command = Command.make("alchemy-console", flags, ({ noOpen, port }) => run(port, noOpen, false)).pipe(
  Command.withDescription("Read-only Alchemy stack API on loopback"),
  Command.withSubcommands([login, serve])
)

const sources = Layer.unwrap(
  loadConfig(home).pipe(
    Effect.mapError(() => new StartupError({ reason: "config" })),
    Effect.map(sourceLayer)
  )
).pipe(Layer.provide(FetchHttpClient.layer), Layer.provide(ssoCredentialsLayer()))
const services = Layer.mergeAll(
  Catalog.layer.pipe(Layer.provide(sources)),
  BrowserOpener.layer,
  configuredPlanLayer.pipe(Layer.provide(FetchHttpClient.layer))
).pipe(
  Layer.provideMerge(NodeServices.layer)
)
const cli = readPackageVersion().pipe(Effect.flatMap((version) => Command.run(command, { version })))

NodeRuntime.runMain(cli.pipe(
  Effect.withTracerEnabled(false),
  Effect.provide(services)
))
