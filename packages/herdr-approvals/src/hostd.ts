import type { AgentWorkerIdentity, FleetStoreError, HostConfiguration, HostOperations } from "@knpkv/herdr-fleet"
import { FleetOperationError, JobStore, loadConfiguration, makeFleetService } from "@knpkv/herdr-fleet"
import { Console, Effect, Path, Redacted, Scope } from "effect"
import type { HostdOperationsCompositionError } from "./errors.js"
import { startHttpServer } from "./http.js"
import { fleetConfigPath } from "./internal/config-path.js"
import { hasOutstandingWorkJob, noJobStore } from "./internal/outstanding-work-job.js"
import { noStartedWorkerStore, startedWorker } from "./internal/started-worker.js"
import { loadUiAssets } from "./internal/ui-assets.js"
import { makeHostOperations } from "./operations.js"

export { HostdOperationsCompositionError } from "./errors.js"
export { runWorkAbandon } from "./work-abandon.js"
export { runWorkReassign } from "./work-reassign.js"

export type HostdLifetimeFork = <A, E>(effect: Effect.Effect<A, E>) => Effect.Effect<void>

export interface HostdOperationsComposition {
  readonly config: HostConfiguration
  readonly defaultOperations: HostOperations
  /** Registers accepted work for interruption when the hostd process scope closes. */
  readonly fork: HostdLifetimeFork
  /**
   * Whether any Work job is still to run: waiting for approval (and not
   * expired), approved and queued, or running. Its preflight tokens hash the
   * whole Work store until it runs, so a background Work writer defers its
   * writes while this is true.
   */
  readonly hasOutstandingWorkJob: Effect.Effect<boolean, FleetStoreError>
  /**
   * The worker Fleet recorded as started for a job, or null when the job is
   * unknown or started none. The authority for which agent a job started;
   * fails with `FleetStoreError` when the job store can't be read.
   */
  readonly startedWorker: (jobId: string) => Effect.Effect<AgentWorkerIdentity | null, FleetStoreError>
}

export type HostdOperationsComposer = (
  composition: HostdOperationsComposition
) => Effect.Effect<HostOperations, HostdOperationsCompositionError>

export interface HostdProgramOptions {
  readonly composeOperations?: HostdOperationsComposer
}

export const makeHostdOperations = Effect.fn("Hostd.makeOperations")(function*(
  config: HostConfiguration,
  composeOperations?: HostdOperationsComposer,
  jobs?: JobStore
) {
  const scope = yield* Scope.Scope
  const defaultOperations = yield* makeHostOperations(config)
  if (composeOperations === undefined) return defaultOperations
  const fork: HostdLifetimeFork = (effect) => Effect.forkIn(effect, scope).pipe(Effect.asVoid)
  return yield* composeOperations({
    config,
    defaultOperations,
    fork,
    hasOutstandingWorkJob: jobs === undefined ? noJobStore : hasOutstandingWorkJob(jobs),
    startedWorker: jobs === undefined ? noStartedWorkerStore : (jobId) => startedWorker(jobs, jobId)
  })
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
  const operations = yield* makeHostdOperations(config, options.composeOperations, store)
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
