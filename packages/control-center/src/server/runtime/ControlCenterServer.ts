import * as Layer from "effect/Layer"
import * as HttpRouter from "effect/unstable/http/HttpRouter"
import type { ServeError } from "effect/unstable/http/HttpServerError"

import { ApiBindConfiguration } from "../api/ApiConfiguration.js"
import type {
  AuthorizedShares,
  DeliveryGraphInspection,
  MediaReads,
  PluginAdministration,
  PortfolioSnapshots,
  RelationshipRepairProposals,
  TimelineExportAudits,
  TimelineReads
} from "../api/ApplicationServices.js"
import { controlCenterApiLayer } from "../api/ControlCenterApiServer.js"
import { requestBoundaryLayer } from "../api/RequestBoundary.js"
import { RequestLimitPolicy, requestRateLimiterLayer } from "../api/RequestLimits.js"
import {
  authorizedSharesLayer,
  deliveryGraphInspectionLayer,
  liveEventsLayer,
  mediaReadsLayer,
  pluginAdministrationLayer,
  pluginAdministrationLayerWithConnections,
  portfolioSnapshotsLayer,
  relationshipRepairProposalsLayer,
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
import { databaseLayer } from "../persistence/Database.js"
import {
  type Persistence,
  type PersistenceLayerError,
  persistenceLayerFromDatabase
} from "../persistence/Persistence.js"
import type { PersistenceConfig } from "../persistence/PersistenceConfig.js"
import type { PluginConnectionMapV1 } from "../plugins/PluginConnectionMap.js"
import { type SecretRoot, SecretStore } from "../secrets/SecretStore.js"
import type { SecretStoreError } from "../secrets/SecretStoreError.js"
import type { BindConfig } from "../security/BindConfig.js"
import {
  type ControlCenterBootstrapError,
  controlCenterBootstrapLayer,
  type ControlCenterBootstrapOptions
} from "./Bootstrap.js"
import { DomainEventWakeups } from "./DomainEventWakeups.js"
import {
  governedActionExecutionServerLayer,
  type GovernedActionExecutionStartupError,
  type GovernedActionExecutionStartupOptions
} from "./GovernedActionExecutionStartup.js"
import { type DirectTlsServerError, makeNodeTransportLayer, nodeSecretPlatformLayer } from "./NodeTransport.js"
import {
  type ReleaseSynchronizationStartupError,
  releaseSynchronizationStartupLayer,
  type ReleaseSynchronizationStartupOptions
} from "./ReleaseSynchronizationStartup.js"
import { requestUrlBoundaryLayer } from "./RequestUrlBoundary.js"

type ControlCenterCoreApplicationServices =
  | AuthorizedShares
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

const liveApplicationServices = (
  pluginConnections: PluginConnectionMapV1 | null
): Layer.Layer<ControlCenterCoreApplicationServices, never, Persistence | SecretStore> =>
  Layer.mergeAll(
    authorizedSharesLayer,
    pluginConnections === null
      ? pluginAdministrationLayer
      : pluginAdministrationLayerWithConnections(pluginConnections),
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
    ApplicationRequirements | Persistence | SecretStore
  > = options.applicationServices ?? liveApplicationServices(
    options.pluginConnections ?? options.releaseSynchronization?.pluginConnections ?? null
  )
  const applicationServices = selectedApplicationServices.pipe(
    Layer.provide(persistence)
  )
  const releaseAgent = options.releaseAgent === undefined || options.releaseAgent === null
    ? releaseAgentUnavailableLayer
    : releaseAgentTurnsLayer(options.releaseAgent).pipe(Layer.provide(applicationServices))
  const liveEventRuntime = liveEventsLayer.pipe(
    Layer.provide(applicationServices),
    Layer.provide(persistence),
    Layer.provideMerge(DomainEventWakeups.layer)
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
    liveEventRuntime
  )
  const routes = Layer.mergeAll(
    controlCenterApiLayer,
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
    runtimeServices
  }
}

/** Compose API routes, request policy, immutable static assets, and startup bootstrap. */
export const makeControlCenterApplication = <ApplicationError = never, ApplicationRequirements = never>(
  options: ControlCenterServerOptions<ApplicationError, ApplicationRequirements>
): ReturnType<typeof makeApplication<ApplicationError, ApplicationRequirements>>["application"] =>
  makeApplication(options).application

/** Construct the fully runnable Node HTTP/HTTPS server layer. */
const makeServer = <ApplicationError = never, ApplicationRequirements = never>(
  options: ControlCenterServerOptions<ApplicationError, ApplicationRequirements>
) => {
  const secrets = SecretStore.layer({ secretRoot: options.secretRoot }).pipe(
    Layer.provide(nodeSecretPlatformLayer)
  )
  const transport = makeNodeTransportLayer(options.bindConfig)
  const application = makeApplication(options)
  return HttpRouter.serve(application.application, { disableLogger: true }).pipe(
    Layer.provide(application.runtimeServices),
    Layer.provide(transport),
    Layer.provide(secrets)
  )
}

/** Construct the fully runnable Node HTTP/HTTPS server layer. */
export const makeControlCenterServer = <ApplicationError = never, ApplicationRequirements = never>(
  options: ControlCenterServerOptions<ApplicationError, ApplicationRequirements>
): ReturnType<typeof makeServer<ApplicationError, ApplicationRequirements>> => makeServer(options)
