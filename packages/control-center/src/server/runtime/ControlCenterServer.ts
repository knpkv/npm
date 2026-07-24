import type * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import type * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import type * as Path from "effect/Path"
import type * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpRouter from "effect/unstable/http/HttpRouter"
import type { ServeError } from "effect/unstable/http/HttpServerError"

import { agentProviderRuntimeRegistryLayer } from "../agent/AgentRuntimeRegistry.js"
import { ApiBindConfiguration } from "../api/ApiConfiguration.js"
import type {
  AuthorizedShares,
  CompleteDiffReads,
  DeliveryGraphInspection,
  MediaReads,
  PluginAdministration,
  PortfolioSnapshots,
  RelationshipRepairProposals,
  TimelineExportAudits,
  TimelineReads
} from "../api/ApplicationServices.js"
import { controlCenterApiLayerWithLifecycle } from "../api/ControlCenterApiServer.js"
import { requestBoundaryLayer } from "../api/RequestBoundary.js"
import { RequestLimitPolicy, requestRateLimiterLayer } from "../api/RequestLimits.js"
import {
  authorizedSharesLayer,
  completeDiffReadsLayer,
  deliveryGraphInspectionLayer,
  liveEventsLayer,
  mediaReadsLayer,
  pluginAdministrationOAuthLayer,
  pluginAdministrationOAuthLayerWithConnections,
  portfolioSnapshotsLayer,
  pullRequestReviewsLayer,
  relationshipRepairProposalsLayer,
  releaseAgentJobsLayer,
  type ReleaseAgentRuntimeOptions,
  releaseAgentTurnsLayer,
  releaseAgentUnavailableLayer,
  timelineExportAuditsLayer,
  timelineReadsLayer
} from "../application/index.js"
import { authLayerFromDatabase } from "../auth/Auth.js"
import {
  StaticAssetStore,
  type StaticAssetStoreError,
  type StaticAssetStoreOptions
} from "../http/security/StaticAssetStore.js"
import { staticApplicationLayer } from "../http/StaticApplication.js"
import { type Database, databaseLayer } from "../persistence/Database.js"
import {
  type Persistence,
  type PersistenceLayerError,
  persistenceLayerFromDatabase
} from "../persistence/Persistence.js"
import type { PersistenceConfig } from "../persistence/PersistenceConfig.js"
import { PluginConnectionMap, type PluginConnectionMapV1 } from "../plugins/PluginConnectionMap.js"
import { type SecretRoot, SecretStore } from "../secrets/SecretStore.js"
import type { SecretStoreError } from "../secrets/SecretStoreError.js"
import type { BindConfig } from "../security/BindConfig.js"
import {
  type ControlCenterBootstrapError,
  controlCenterBootstrapLayer,
  type ControlCenterBootstrapOptions
} from "./Bootstrap.js"
import { databaseDrainLayer } from "./DatabaseDrain.js"
import { DomainEventWakeups } from "./DomainEventWakeups.js"
import { firstPartyPluginConnectionMapLayer } from "./FirstPartyPluginRuntime.js"
import {
  governedActionExecutionServerLayer,
  type GovernedActionExecutionStartupError,
  type GovernedActionExecutionStartupOptions
} from "./GovernedActionExecutionStartup.js"
import {
  type DirectTlsServerError,
  makeNodeTransportLayer,
  nodeOutboundHttpClientLayer,
  nodeSecretPlatformLayer
} from "./NodeTransport.js"
import {
  type ReleaseSynchronizationStartupError,
  releaseSynchronizationStartupLayer,
  type ReleaseSynchronizationStartupOptions
} from "./ReleaseSynchronizationStartup.js"
import { requestUrlBoundaryLayer } from "./RequestUrlBoundary.js"
import { ServerLifecycle } from "./ServerLifecycle.js"

type ControlCenterCoreApplicationServices =
  | AuthorizedShares
  | CompleteDiffReads
  | DeliveryGraphInspection
  | MediaReads
  | PluginAdministration
  | PortfolioSnapshots
  | RelationshipRepairProposals
  | TimelineExportAudits
  | TimelineReads

/** Runtime construction settings after security and persistence decoding. */
export interface ControlCenterServerOptions<ApplicationError = never, ApplicationRequirements = never> {
  readonly bindConfig: BindConfig
  readonly persistenceConfig: PersistenceConfig
  /** Scoped first-party provider runtimes used by live connection checks. */
  readonly pluginConnections?: PluginConnectionMapV1 | null
  /** Enable the fixed production provider registry when no test map is injected. */
  readonly firstPartyPluginRuntime?: boolean | undefined
  readonly secretRoot: SecretRoot
  readonly staticAssets: StaticAssetStoreOptions
  readonly bootstrap?: ControlCenterBootstrapOptions | null
  readonly releaseSynchronization?: ReleaseSynchronizationStartupOptions | null
  readonly releaseAgent?: ReleaseAgentRuntimeOptions | null
  readonly governedActionExecution?: GovernedActionExecutionStartupOptions | null
  readonly applicationServices?: Layer.Layer<
    ControlCenterCoreApplicationServices,
    ApplicationError,
    ApplicationRequirements | Persistence | SecretStore
  >
}

/** Failures that can prevent the runtime from acquiring or listening. */
export type ControlCenterServerError<ApplicationError = never> =
  | ApplicationError
  | ControlCenterBootstrapError
  | DirectTlsServerError
  | GovernedActionExecutionStartupError
  | PersistenceLayerError
  | ReleaseSynchronizationStartupError
  | SecretStoreError
  | ServeError
  | StaticAssetStoreError

const pluginApplicationServices = (
  pluginConnections: PluginConnectionMapV1 | null,
  firstPartyPluginRuntime: boolean,
  publicOrigin: string,
  firstPartyConnectionsLayer: typeof firstPartyPluginConnectionMapLayer
) => {
  if (pluginConnections !== null) {
    return Layer.merge(
      pluginAdministrationOAuthLayerWithConnections(pluginConnections, publicOrigin),
      completeDiffReadsLayer(pluginConnections)
    )
  }
  if (!firstPartyPluginRuntime) {
    return Layer.merge(
      pluginAdministrationOAuthLayer(publicOrigin),
      completeDiffReadsLayer(null)
    )
  }
  return Layer.unwrap(
    Effect.map(
      PluginConnectionMap,
      (connections) =>
        Layer.merge(
          pluginAdministrationOAuthLayerWithConnections(connections, publicOrigin),
          completeDiffReadsLayer(connections)
        )
    )
  ).pipe(Layer.provideMerge(firstPartyConnectionsLayer))
}

/** Compose the live application boundary, with an injectable first-party map layer for focused runtime tests. @internal */
export const liveApplicationServices = (
  pluginConnections: PluginConnectionMapV1 | null,
  firstPartyPluginRuntime: boolean,
  publicOrigin: string,
  firstPartyConnectionsLayer = firstPartyPluginConnectionMapLayer
): Layer.Layer<
  ControlCenterCoreApplicationServices,
  never,
  | Crypto.Crypto
  | Database
  | DomainEventWakeups
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | Path.Path
  | Persistence
  | SecretStore
> =>
  Layer.mergeAll(
    authorizedSharesLayer,
    pluginApplicationServices(
      pluginConnections,
      firstPartyPluginRuntime,
      publicOrigin,
      firstPartyConnectionsLayer
    ),
    deliveryGraphInspectionLayer,
    portfolioSnapshotsLayer,
    timelineExportAuditsLayer,
    timelineReadsLayer,
    mediaReadsLayer,
    relationshipRepairProposalsLayer
  )

/** Compose API routes, request policy, immutable static assets, and startup bootstrap. */
const makeApplication = <ApplicationError = never, ApplicationRequirements = never>(
  options: ControlCenterServerOptions<ApplicationError, ApplicationRequirements>
) => {
  const database = databaseLayer(options.persistenceConfig)
  const persistence = persistenceLayerFromDatabase(options.persistenceConfig).pipe(
    Layer.provide(database)
  )
  const authentication = authLayerFromDatabase.pipe(Layer.provide(database))
  const apiBindConfiguration = ApiBindConfiguration.layer(options.bindConfig)
  const staticAssets = StaticAssetStore.layer(options.staticAssets)
  const selectedApplicationServices: Layer.Layer<
    ControlCenterCoreApplicationServices,
    ApplicationError,
    | ApplicationRequirements
    | Crypto.Crypto
    | Database
    | DomainEventWakeups
    | FileSystem.FileSystem
    | HttpClient.HttpClient
    | Path.Path
    | Persistence
    | SecretStore
  > = options.applicationServices ?? liveApplicationServices(
    options.pluginConnections ?? options.releaseSynchronization?.pluginConnections ?? null,
    options.firstPartyPluginRuntime ?? false,
    options.bindConfig.publicOrigin
  )
  const domainEventWakeups = DomainEventWakeups.layer
  const lifecycle = ServerLifecycle.layer
  const databaseDrain = databaseDrainLayer.pipe(Layer.provide(database))
  const applicationServices = selectedApplicationServices.pipe(
    Layer.provide(persistence),
    Layer.provide(database),
    Layer.provide(domainEventWakeups)
  )
  const releaseAgent = options.releaseAgent === undefined || options.releaseAgent === null
    ? releaseAgentUnavailableLayer
    : releaseAgentTurnsLayer(options.releaseAgent).pipe(Layer.provide(applicationServices))
  const providerRegistry = agentProviderRuntimeRegistryLayer(
    options.releaseAgent === undefined || options.releaseAgent === null
      ? {}
      : {
        ...(options.releaseAgent.enabledProviders.includes("codex")
          ? {
            codex: {
              cwd: options.releaseAgent.cwd,
              ...(options.releaseAgent.codexExecutable === undefined
                ? {}
                : { executable: options.releaseAgent.codexExecutable }),
              ...(options.releaseAgent.codexModel === undefined
                ? {}
                : { model: options.releaseAgent.codexModel })
            }
          }
          : {}),
        ...(options.releaseAgent.enabledProviders.includes("claude")
          ? {
            claude: {
              cwd: options.releaseAgent.cwd,
              ...(options.releaseAgent.claudeExecutable === undefined
                ? {}
                : { executable: options.releaseAgent.claudeExecutable }),
              ...(options.releaseAgent.claudeModel === undefined
                ? {}
                : { model: options.releaseAgent.claudeModel })
            }
          }
          : {}),
        ...(options.releaseAgent.openAiCompatible === undefined
          ? {}
          : { openAiCompatible: options.releaseAgent.openAiCompatible })
      }
  )
  const releaseAgentJobs = releaseAgentJobsLayer.pipe(
    Layer.provide(providerRegistry),
    Layer.provide(persistence)
  )
  const pullRequestReviews = pullRequestReviewsLayer.pipe(
    Layer.provide(providerRegistry),
    Layer.provide(persistence),
    Layer.provide(applicationServices)
  )
  const liveEventRuntime = liveEventsLayer.pipe(
    Layer.provide(applicationServices),
    Layer.provide(persistence),
    Layer.provideMerge(domainEventWakeups)
  )
  const governedActionExecution = governedActionExecutionServerLayer(
    options.governedActionExecution ?? null
  ).pipe(Layer.provide(database))
  const runtimeServices = Layer.mergeAll(
    apiBindConfiguration,
    RequestLimitPolicy.defaultLayer,
    requestRateLimiterLayer,
    staticAssets,
    persistence,
    authentication,
    applicationServices,
    releaseAgent,
    releaseAgentJobs,
    pullRequestReviews,
    liveEventRuntime,
    databaseDrain
  )
  const routes = Layer.mergeAll(
    controlCenterApiLayerWithLifecycle,
    staticApplicationLayer,
    requestUrlBoundaryLayer,
    requestBoundaryLayer,
    governedActionExecution,
    releaseSynchronizationStartupLayer(options.releaseSynchronization ?? null).pipe(
      Layer.provideMerge(controlCenterBootstrapLayer(options.bootstrap ?? null))
    )
  )
  return {
    application: routes.pipe(Layer.provideMerge(runtimeServices)),
    lifecycle,
    runtimeServices
  }
}

/** Compose API routes, request policy, immutable static assets, and startup bootstrap. */
export const makeControlCenterApplication = <ApplicationError = never, ApplicationRequirements = never>(
  options: ControlCenterServerOptions<ApplicationError, ApplicationRequirements>
): ReturnType<typeof makeApplication<ApplicationError, ApplicationRequirements>>["application"] => {
  const application = makeApplication(options)
  return application.application.pipe(Layer.provide(application.lifecycle))
}

/** Construct the fully runnable Node HTTP/HTTPS server layer. */
const makeServer = <ApplicationError = never, ApplicationRequirements = never>(
  options: ControlCenterServerOptions<ApplicationError, ApplicationRequirements>
) => {
  const secrets = SecretStore.layer({ secretRoot: options.secretRoot }).pipe(
    Layer.provide(nodeSecretPlatformLayer)
  )
  const transport = makeNodeTransportLayer(options.bindConfig)
  const application = makeApplication(options)
  const server = HttpRouter.serve(application.application, { disableLogger: true }).pipe(
    Layer.provide(application.runtimeServices),
    Layer.provide(transport),
    Layer.provide(secrets),
    Layer.provide(nodeOutboundHttpClientLayer),
    Layer.provideMerge(application.lifecycle)
  )
  return server
}

/** Construct the fully runnable Node HTTP/HTTPS server layer. */
export const makeControlCenterServer = <ApplicationError = never, ApplicationRequirements = never>(
  options: ControlCenterServerOptions<ApplicationError, ApplicationRequirements>
): ReturnType<typeof makeServer<ApplicationError, ApplicationRequirements>> => makeServer(options)
