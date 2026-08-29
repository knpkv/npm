#!/usr/bin/env bun
/**
 * The `codecommit` executable: command composition, runtime layers, teardown.
 *
 * Each subcommand owns its own flags, help text, service and layer stack in its
 * own module, so what is left here is the shape of the CLI rather than the work
 * any of it does. The one thing that genuinely belongs at this boundary is the
 * host process read for {@link ChildEnv}.
 *
 * @module
 */
import { BunRuntime, BunServices } from "@effect/platform-bun"
import { NodeHttpClient } from "@effect/platform-node"
import { makeInstallCommand } from "@knpkv/agent-skills"
import { AwsClientConfig, ChildEnv } from "@knpkv/codecommit-core"
import {
  makeOwnerSessionSecrets,
  makeServer,
  ownerSessionOrigin,
  ownerSessionUrl,
  requireLoopbackHostname
} from "@knpkv/codecommit-web"
import { Console, Deferred, Effect, Fiber, Layer, Stream } from "effect"
import * as Runtime from "effect/Runtime"
import * as Stdio from "effect/Stdio"
import { Command, Flag as Options } from "effect/unstable/cli"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import pkg from "../package.json"
import { prCreateCommand } from "./PrCreate.js"
import { prExportCommand } from "./PrExport.js"
import { prListCommand } from "./PrList.js"
import { prOpenCommand } from "./PrOpen.js"
import { prUpdateCommand } from "./PrUpdate.js"

// TUI Command
const launchTui = Effect.gen(function*() {
  const { default: program } = yield* Effect.promise(() => import("./main.js"))
  yield* program
})

const tui = Command.make("tui", {}, () => launchTui)

// Web Command
const web = Command.make("web", {
  port: Options.integer("port").pipe(Options.withDefault(3000)),
  hostname: Options.string("hostname").pipe(Options.withDefault("127.0.0.1"))
}, ({ hostname, port }) =>
  Effect.gen(function*() {
    yield* requireLoopbackHostname(hostname)
    const security = yield* makeOwnerSessionSecrets()
    const ready = yield* Deferred.make<void>()
    const url = ownerSessionUrl(hostname, port, security)
    const stdio = yield* Stdio.Stdio
    const serverFiber = yield* Layer.launch(makeServer({ port, hostname, ready, security })).pipe(
      Effect.forkChild({ startImmediately: true })
    )
    yield* Effect.raceFirst(Deferred.await(ready), Fiber.join(serverFiber))
    yield* Effect.logInfo(`Authenticated web server ready at ${ownerSessionOrigin(hostname, port)}`)
    yield* Stream.make(`Authenticated bootstrap URL: ${url}\n`).pipe(Stream.run(stdio.stdout()))

    // Open browser
    const exitCode = (command: ChildProcess.Command) =>
      Effect.scoped(command.pipe(Effect.flatMap((handle) => handle.exitCode)))
    yield* exitCode(ChildProcess.make("open", [url])).pipe(
      Effect.catchIf(() => true, () => exitCode(ChildProcess.make("xdg-open", [url]))),
      Effect.catchIf(
        () => true,
        () => exitCode(ChildProcess.make("rundll32.exe", ["url.dll,FileProtocolHandler", url]))
      ),
      Effect.catchIf(() => true, () => Effect.void)
    )

    // Keep the supervised server alive after readiness and bootstrap handoff.
    return yield* Fiber.join(serverFiber)
  }))

// PR Command (parent)
const pr = Command.make("pr", {}, () => Console.log("Usage: codecommit pr <command>")).pipe(
  Command.withSubcommands([prListCommand, prCreateCommand, prExportCommand, prUpdateCommand, prOpenCommand]),
  Command.withDescription("Pull request commands")
)

const skillsInstall = makeInstallCommand({
  description: "Install the CodeCommit agent skill",
  name: "install",
  skills: ["codecommit"]
})

const skills = Command.make("skills", {}, () => Console.log("Usage: codecommit skills install")).pipe(
  Command.withSubcommands([skillsInstall]),
  Command.withDescription("Agent skill commands")
)

const command = Command.make("codecommit", {}, () =>
  // Default to TUI if no subcommand
  launchTui).pipe(
    Command.withSubcommands([tui, web, pr, skills])
  )

const cli = Command.runWith(command, {
  version: pkg.version
})

// The executable boundary is the only place permitted to read the host process.
// Profile-scoped spawns need the environment they will actually inherit so ambient AWS
// variables are tombstoned under whatever casing the host exported them with.
const AppRuntimeLayer = Layer.mergeAll(
  NodeHttpClient.layerFetch,
  AwsClientConfig.Default,
  ChildEnv.layerHostEnvironment(process.env)
)

const program = Effect.gen(function*() {
  const stdio = yield* Stdio.Stdio
  const args = yield* stdio.args
  // This is the application entry point — the case the diagnostic exempts.
  // @effect-diagnostics-next-line strictEffectProvide:off
  return yield* cli(args).pipe(Effect.provide(AppRuntimeLayer))
})

// The TUI keeps long-lived resources open through its atom runtime (SQLite
// repos, the HTTP client, the EventsHub PubSub). When the user quits in-app the
// main fiber exits cleanly (code 0) and — because OpenTUI holds stdin in raw
// mode, so Ctrl-C is delivered as a keypress, not a SIGINT — runMain's default
// teardown never reaches `process.exit`. The process would then hang on those
// open handles after the UI has already torn down. Always terminate explicitly.
const forceExitTeardown: Runtime.Teardown = (exit) => Runtime.defaultTeardown(exit, (code) => process.exit(code))

// The outermost provide, on the line that starts the runtime.
// @effect-diagnostics-next-line strictEffectProvide:off
BunRuntime.runMain(Effect.provide(program, BunServices.layer), { teardown: forceExitTeardown })
