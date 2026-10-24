#!/usr/bin/env node
// `herdr-hub apps …`: builds the CLI's environment from this machine (paths, the hub's loopback port, this process)
// and runs the command. Everything it decides is in `cli.ts`.
import { NodeHttpClient, NodeRuntime, NodeServices } from "@effect/platform-node"
import { HubPaths, loadConfiguration } from "@knpkv/herdr-fleet"
import type { Crypto } from "effect"
import { Console, Effect, FileSystem, Layer, Option, Path, Schema } from "effect"
import { Command } from "effect/cli"
import type { ChildProcessSpawner } from "effect/process"
import { hostname } from "node:os"
import process from "node:process"
import manifest from "../../package.json" with { type: "json" }
import { builtInModuleIds } from "../module-contract.js"
import { AppsCli, appsCommand, makeHubClient, waitStopped } from "./cli.js"
import { makeInstaller } from "./installer.js"
import { findNpmCli, makeNpm } from "./npm.js"
import { makeAppsStore } from "./store.js"
import { prepareEndpointPlace } from "./supervisor.js"

const windows = process.platform === "win32"

/** Whether `pid` runs on this machine: signal 0 checks without sending; EPERM means it runs as someone else. */
const SystemErrorCode = Schema.Struct({ code: Schema.String })
const processAlive = (pid: number) =>
  Effect.try({
    try: () => process.kill(pid, 0),
    catch: (error) =>
      Option.match(Schema.decodeUnknownOption(SystemErrorCode)(error), {
        onNone: () => false,
        onSome: ({ code }) => code === "EPERM"
      })
  }).pipe(Effect.as(true), Effect.catch((runsAsSomeoneElse) => Effect.succeed(runsAsSomeoneElse)))

const environment = Layer.effect(
  AppsCli,
  Effect.gen(function*() {
    const paths = yield* HubPaths
    const path = yield* Path.Path
    const fileSystem = yield* FileSystem.FileSystem
    const appsRoot = path.join(paths.hubData, "hub-apps")
    yield* fileSystem.makeDirectory(appsRoot, { recursive: true })
    // No fleet config (or none readable): there is no hub to ask, and the CLI still writes apps.json.
    const localPort = yield* loadConfiguration(paths.fleetConfig).pipe(
      Effect.map((config) => Option.some(config.localPort)),
      Effect.catch((error) =>
        Effect.logDebug("herdr-hub apps: no fleet config, so no hub to ask", error).pipe(
          Effect.as(Option.none<number>())
        )
      )
    )
    const hub = yield* makeHubClient({
      url: Option.match(localPort, { onNone: () => null, onSome: (port) => `http://127.0.0.1:${port}/` }),
      tokenDirectory: path.join(paths.hubState, "cli")
    })
    const store = yield* makeAppsStore({
      configPath: paths.appsConfig,
      lockPath: path.join(appsRoot, ".lock"),
      self: { pid: process.pid, host: hostname() },
      processAlive
    })
    const user = { name: process.env.USER ?? process.env.USERNAME ?? "user", uid: process.getuid?.() ?? -1 }
    const context = yield* Effect.context<
      FileSystem.FileSystem | Path.Path | Crypto.Crypto | ChildProcessSpawner.ChildProcessSpawner
    >()
    return {
      store,
      hub,
      logsDirectory: path.join(paths.hubState, "logs"),
      interactive: process.stdin.isTTY,
      // npm is looked for only by commands that install: `list`, `logs` and the rest work without it.
      installer: (confirm) =>
        Effect.gen(function*() {
          const npmCli = yield* findNpmCli({ execPath: process.execPath, windows, path: process.env.PATH ?? "" })
          const npm = yield* makeNpm({ node: process.execPath, npmCli, cwd: appsRoot })
          return yield* makeInstaller({
            store,
            npm,
            hubData: paths.hubData,
            node: process.execPath,
            windows,
            coreModuleIds: builtInModuleIds,
            // The probe's own base beside the hub's, so the hub's endpoint directory is never wiped.
            probePlace: prepareEndpointPlace({
              runtimeDirectory: paths.hubRuntime === null ? null : `${paths.hubRuntime}-probe`,
              shortRuntimeDirectory: path.join(paths.hubState, "probe"),
              user
            }),
            confirm,
            waitStopped: (id) => waitStopped(hub, id),
            say: (line) => Console.log(line)
          })
        }).pipe(Effect.provideContext(context))
    }
  })
)

const platform = Layer.mergeAll(Layer.provideMerge(HubPaths.layer, NodeServices.layer), NodeHttpClient.layerNodeHttp)

Command.make("herdr-hub").pipe(
  Command.withSubcommands([appsCommand]),
  Command.run({ version: manifest.version }),
  Effect.provide(Layer.provideMerge(environment, platform)),
  NodeRuntime.runMain
)
