#!/usr/bin/env node
/**
 * `jcf-web [--no-open] [--port N]` signs in to the running week view or starts one in the foreground,
 * opens the browser when allowed, and prints the bare sign-in URL on stdout.
 *
 * `jcf-web serve` keeps the print-only foreground start for service managers.
 * `jcf-web login` (the same as `jcf web login`) asks the running server for a fresh one-time URL.
 * A reused server is left running; a server started here ends with SIGINT/SIGTERM, never tab closure.
 *
 * @module
 */
import { NodeHttpClient, NodeRuntime, NodeServices } from "@effect/platform-node"
import { issueCredential } from "@knpkv/browser-pairing"
import { type BrowserLaunchOutputError, BrowserOpener } from "@knpkv/browser-pairing/launch"
import { loopbackOrigin, serveWithBootstrapUrl } from "@knpkv/browser-pairing/owner-session"
import { Layers } from "@knpkv/jira-clockify"
import { Effect, Layer, Logger, Option, Redacted } from "effect"
import { Command } from "effect/cli"
import pkg from "../package.json" with { type: "json" }
import { announceWeekView, makeCommand } from "./Command.js"
import { makeOwnerSession } from "./server/OwnerSession.js"
import { makeServer, Port, PublicOrigin } from "./server/Server.js"

const serve = Effect.fn("JcfWeb.serve")(function*(
  chosenPort: Option.Option<number>,
  announce: (url: string) => Effect.Effect<void, BrowserLaunchOutputError>
) {
  const port = Option.isSome(chosenPort) ? chosenPort.value : yield* Port
  const configuredOrigin = yield* PublicOrigin
  const authorityOrigin = loopbackOrigin("127.0.0.1", port)
  // One origin decision: the URL that gets printed is the same origin every request is checked
  // against, so a dev proxy in front of the server cannot be advertised and then rejected.
  const security = yield* makeOwnerSession(authorityOrigin, Option.getOrUndefined(configuredOrigin))
  // Proves to /control/login that the caller could read the owner-only control file.
  const controlToken = yield* issueCredential()
  return yield* serveWithBootstrapUrl(
    (ready) => makeServer({ port, ready, security, controlToken }),
    (url) => announceWeekView(authorityOrigin, Redacted.value(controlToken), url, announce)
  )
})

const cli = makeCommand(serve).pipe(Command.run({ version: pkg.version }))

// Executable entry point: the host platform is provided once for this process.
const runtime = Layer.mergeAll(
  Layers.HomeDirectoryLive,
  NodeServices.layer,
  NodeHttpClient.layerFetch,
  BrowserOpener.layer.pipe(Layer.provide(NodeServices.layer)),
  Layer.succeed(Logger.LogToStderr, true)
)
NodeRuntime.runMain(cli.pipe(Effect.scoped, Effect.provide(runtime)))
