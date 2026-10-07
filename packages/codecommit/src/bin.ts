#!/usr/bin/env node
/**
 * The `codecommit` executable: command composition, runtime layers, teardown.
 *
 * Each subcommand owns its flags, help text, and service layer in its own
 * module. This boundary supplies shared infrastructure, including the selected
 * AWS transport and the host environment used by profile-scoped children.
 *
 * @module
 */
import { NodeHttpClient, NodeRuntime, NodeServices } from "@effect/platform-node"
import { makeInstallCommand } from "@knpkv/agent-skills"
import { AwsClient, AwsClientConfig, CacheService, ChildEnv, ConfigService } from "@knpkv/codecommit-core"
import {
  codeCommitMockAwsClientConfig,
  decodeCodeCommitMockEndpointEffect,
  withCodeCommitMock
} from "@knpkv/codecommit-core/MockTransport.js"
import { requireLoopbackHostname, serveCodeCommit } from "@knpkv/codecommit-web"
import { Console, Data, Effect, Layer } from "effect"
import { Command, Flag as Options } from "effect/cli"
import * as HttpClient from "effect/http/HttpClient"
import * as ChildProcess from "effect/process/ChildProcess"
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner"
import * as Runtime from "effect/Runtime"
import * as Stdio from "effect/Stdio"
import { fileURLToPath } from "node:url"
import pkg from "../package.json" with { type: "json" }
import { reportFailure } from "./CliFailure.js"
import { prCreateCommand } from "./PrCreate.js"
import { prExportCommand } from "./PrExport.js"
import { prListCommand } from "./PrList.js"
import { prOpenCommand } from "./PrOpen.js"
import { prUpdateCommand } from "./PrUpdate.js"

/**
 * The terminal UI runs on OpenTUI, which needs Bun; everything else runs on Node or Bun. Without Bun
 * the process prints one line and exits 1, with no error report.
 */
class TuiNeedsBun extends Data.TaggedError("TuiNeedsBun") {
  override readonly [Runtime.errorReported] = false
  override readonly [Runtime.errorExitCode] = 1
}

/** The Bun-hosted TUI ended with a failure code; this process exits with the same code. */
class TuiExited extends Data.TaggedError("TuiExited")<{ readonly code: number }> {
  override readonly [Runtime.errorReported] = false
  override get [Runtime.errorExitCode](): number {
    return this.code
  }
}

const tuiNeedsBunMessage =
  "codecommit: the terminal UI needs Bun. Install it from https://bun.sh and run codecommit again, " +
  "or run `codecommit web` for the browser UI."

/**
 * Under Bun the TUI starts in this process. Under Node it re-runs this executable with Bun on the
 * same terminal, so `codecommit` works from either runtime when Bun is installed.
 */
const launchTui = Effect.gen(function*() {
  if (process.versions.bun !== undefined) {
    // A pipe or a script gets one line instead of a full-screen UI it cannot show.
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      return yield* reportFailure(
        "codecommit: the terminal UI needs an interactive terminal. Run `codecommit --help` for the commands that work in scripts."
      )
    }
    const { default: program } = yield* Effect.promise(() => import("./main.js"))
    return yield* program
  }
  const code = yield* Effect.scoped(
    ChildProcess.make("bun", [fileURLToPath(import.meta.url), "tui"], {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit"
    }).pipe(Effect.flatMap((handle) => handle.exitCode))
  ).pipe(Effect.mapError(() => new TuiNeedsBun()))
  if (code !== 0) return yield* new TuiExited({ code })
})

const tui = Command.make("tui", {}, () => launchTui).pipe(
  Command.withDescription("Open the terminal UI (needs Bun and an interactive terminal)")
)

// Web Command
const web = Command.make("web", {
  port: Options.Int("port").pipe(Options.withDescription("Port to listen on"), Options.withDefault(3000)),
  hostname: Options.String("hostname").pipe(
    Options.withDescription("Loopback address to listen on, such as 127.0.0.1 or ::1"),
    Options.withDefault("127.0.0.1")
  )
}, ({ hostname, port }) =>
  Effect.gen(function*() {
    yield* requireLoopbackHostname(hostname)
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    // The same start as the web package's own entry; this command adds opening the browser.
    return yield* serveCodeCommit({
      hostname,
      onReady: (url) => openBrowser(url).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner)),
      port
    })
  })).pipe(Command.withDescription("Serve the browser UI on this machine and open it"))

/** Best effort: the URL is already printed, so a missing browser leaves nothing unfinished. */
const openBrowser = (url: string) => {
  const exitCode = (command: ChildProcess.Command) =>
    Effect.scoped(command.pipe(Effect.flatMap((handle) => handle.exitCode)))
  return exitCode(ChildProcess.make("open", [url])).pipe(
    Effect.catchIf(() => true, () => exitCode(ChildProcess.make("xdg-open", [url]))),
    Effect.catchIf(
      () => true,
      () => exitCode(ChildProcess.make("rundll32.exe", ["url.dll,FileProtocolHandler", url]))
    ),
    Effect.ignore
  )
}

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
const HostEnvironmentLayer = ChildEnv.layerHostEnvironment(process.env)
const AwsRuntimeLayer = Layer.unwrap(
  Effect.map(ChildEnv.HostEnvironment, ({ variables }) => {
    const configuredMockEndpoint = variables.CODECOMMIT_MOCK_ENDPOINT?.trim()
    const httpClient = configuredMockEndpoint === undefined || configuredMockEndpoint.length === 0
      ? NodeHttpClient.layerFetch
      : Layer.effect(
        HttpClient.HttpClient,
        Effect.gen(function*() {
          const client = yield* HttpClient.HttpClient
          return withCodeCommitMock(client, yield* decodeCodeCommitMockEndpointEffect(configuredMockEndpoint))
        })
      ).pipe(Layer.provide(NodeHttpClient.layerFetch))
    const configuration = configuredMockEndpoint === undefined || configuredMockEndpoint.length === 0
      ? AwsClientConfig.Default
      : codeCommitMockAwsClientConfig
    const client = AwsClient.AwsClientLive.pipe(
      Layer.provide(httpClient),
      Layer.provide(configuration)
    )
    return Layer.mergeAll(httpClient, configuration, client)
  })
).pipe(Layer.provide(HostEnvironmentLayer))
const ConfigServiceLayer = ConfigService.ConfigServiceLive.pipe(
  Layer.provide(CacheService.EventsHub.Default)
)

const AppRuntimeLayer = Layer.mergeAll(
  AwsRuntimeLayer,
  ConfigServiceLayer,
  HostEnvironmentLayer
)
const RuntimeLayer = AppRuntimeLayer.pipe(Layer.provideMerge(NodeServices.layer))

const program = Effect.gen(function*() {
  const stdio = yield* Stdio.Stdio
  const args = yield* stdio.args
  return yield* cli(args)
})

// The TUI keeps long-lived resources open through its atom runtime (SQLite
// repos, the HTTP client, the EventsHub PubSub). When the user quits in-app the
// main fiber exits cleanly (code 0) and — because OpenTUI holds stdin in raw
// mode, so Ctrl-C is delivered as a keypress, not a SIGINT — runMain's default
// teardown never reaches `process.exit`. The process would then hang on those
// open handles after the UI has already torn down. Always terminate explicitly.
const forceExitTeardown: Runtime.Teardown = (exit) => Runtime.defaultTeardown(exit, (code) => process.exit(code))

// A missing Bun is a setup step, not a crash: one line naming it and the fix, exit 1.
const main = program.pipe(
  Effect.tapErrorTag("TuiNeedsBun", () => Console.error(tuiNeedsBunMessage))
)

// @effect-diagnostics-next-line strictEffectProvide:off
NodeRuntime.runMain(Effect.provide(main, RuntimeLayer), {
  teardown: forceExitTeardown
})
