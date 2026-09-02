#!/usr/bin/env node
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { FleetOperationError, JobStore, loadConfiguration, makeFleetService } from "@knpkv/herdr-fleet"
import { Console, Effect, FileSystem, Path, Redacted } from "effect"
import { startHttpServer, type UiAssets } from "./http.js"
import { fleetConfigPath } from "./internal/config-path.js"
import { makeHostOperations } from "./operations.js"

const loadUiAssets = Effect.fn("Hostd.loadUiAssets")(function*(directory: string) {
  const fileSystem = yield* FileSystem.FileSystem
  const paths = yield* Path.Path
  const stylesheet = yield* fileSystem.readFileString(paths.join(directory, "index.css"))
  const fontNames = new Set(
    [...stylesheet.matchAll(/url\(["']?\.\/([^"')]+\.woff2)/g)].flatMap((match) =>
      match[1] === undefined ? [] : [match[1]]
    )
  )
  const fonts = yield* Effect.forEach(
    [...fontNames],
    (name) =>
      fileSystem.readFile(paths.join(directory, name)).pipe(
        Effect.map((contents): readonly [string, Uint8Array] => [name, contents])
      )
  )
  return {
    connectScript: yield* fileSystem.readFileString(paths.join(directory, "connect.js")),
    fonts: new Map(fonts),
    script: yield* fileSystem.readFileString(paths.join(directory, "approval.js")),
    stylesheet,
    worker: yield* fileSystem.readFileString(paths.join(directory, "approval-sw.js"))
  } satisfies UiAssets
})

const program = Effect.gen(function*() {
  const paths = yield* Path.Path
  const configPath = yield* fleetConfigPath
  const config = yield* loadConfiguration(configPath)
  const store = yield* Effect.acquireRelease(
    JobStore.open(paths.join(config.stateDirectory, "jobs.sqlite")),
    (opened) => Effect.sync(() => opened.close())
  )
  const operations = yield* makeHostOperations(config)
  const service = yield* makeFleetService({
    approvalEnabled: config.crossHost,
    host: config.host,
    operations,
    store
  })
  const directory = paths.dirname(yield* paths.fromFileUrl(new URL(import.meta.url)))
  const assets = yield* loadUiAssets(directory)
  const serverOptions = config.lanWork === undefined ? {} : { lanWork: config.lanWork }
  const server = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () => startHttpServer(config, service, assets, serverOptions),
      catch: (cause) => new FleetOperationError({ cause, detail: String(cause), operation: "hostd.listen" })
    }),
    (running) => Effect.promise(running.close)
  )
  yield* Console.log(
    `hostd: ${config.host} local=${server.url} work=${server.workUrl ?? "canonical"} tailnet=${
      server.tailnetUrl ?? "disabled"
    } approval=${server.approvalUrl ?? "disabled"} serve=${server.serveUrl ?? "disabled"} lan-work=${
      server.lanWorkUrl ?? "disabled"
    }`
  )
  if (server.lanWorkPairingCode !== null) {
    yield* Console.log(`LAN Work pairing code: ${Redacted.value(server.lanWorkPairingCode)}`)
  }
  return yield* Effect.never
})

program.pipe(
  Effect.scoped,
  // The hostd process owns the Node service layer for its full lifetime.
  // @effect-diagnostics-next-line strictEffectProvide:off
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain({ disableErrorReporting: false })
)
