import type { HostConfiguration, HostOperations } from "@knpkv/herdr-fleet"
import { FleetOperationError, JobStore, loadConfiguration, makeFleetService } from "@knpkv/herdr-fleet"
import { Console, Effect, FileSystem, Path, Redacted, Scope } from "effect"
import type { HostdOperationsCompositionError } from "./errors.js"
import { startHttpServer, type UiAssets } from "./http.js"
import { fleetConfigPath } from "./internal/config-path.js"
import { makeHostOperations } from "./operations.js"

export { HostdOperationsCompositionError } from "./errors.js"

export interface HostdOperationsComposition {
  readonly config: HostConfiguration
  readonly defaultOperations: HostOperations
  /** Lifetime for accepted work that outlives the immediate fleet operation. */
  readonly scope: Scope.Scope
}

export type HostdOperationsComposer = (
  composition: HostdOperationsComposition
) => Effect.Effect<HostOperations, HostdOperationsCompositionError>

export interface HostdProgramOptions {
  readonly composeOperations?: HostdOperationsComposer
}

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

export const makeHostdOperations = Effect.fn("Hostd.makeOperations")(function*(
  config: HostConfiguration,
  composeOperations?: HostdOperationsComposer
) {
  const scope = yield* Scope.Scope
  const defaultOperations = yield* makeHostOperations(config)
  if (composeOperations === undefined) return defaultOperations
  return yield* composeOperations({ config, defaultOperations, scope })
})

/**
 * Builds the hostd process as one Effect program. Consumers may decorate the
 * package-owned typed operations without replacing startup, approval, or HTTP
 * authorization behavior. The caller owns the single runtime and Node layer.
 */
export const makeHostdProgram = Effect.fn("Hostd.makeProgram")(function*(
  options: HostdProgramOptions = {}
) {
  const paths = yield* Path.Path
  const configPath = yield* fleetConfigPath
  const config = yield* loadConfiguration(configPath)
  const store = yield* Effect.acquireRelease(
    JobStore.open(paths.join(config.stateDirectory, "jobs.sqlite")),
    (opened) => Effect.sync(() => opened.close())
  )
  const operations = yield* makeHostdOperations(config, options.composeOperations)
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
