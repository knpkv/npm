import type * as Crypto from "effect/Crypto"
import type * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import type * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import type * as Path from "effect/Path"
import * as Schema from "effect/Schema"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpRouter from "effect/unstable/http/HttpRouter"
import type { ServeError } from "effect/unstable/http/HttpServerError"

import { type AgentJobWorkerOptions, prReviewAgentJobWorkerLayer } from "../agent/AgentJobWorker.js"
import { agentProviderRuntimeRegistryLayer } from "../agent/AgentRuntimeRegistry.js"
import {
  type PrReviewSandboxSessionError,
  PrReviewSandboxSessions,
  prReviewSandboxSessionsLayer
} from "../agent/internal/PrReviewSandboxSession.js"
import {
  codeCommitPrReviewSourceResolverLayer,
  type PrReviewSourceError,
  PrReviewSourceWorkspace,
  prReviewSourceWorkspaceLayer,
  prReviewWorkspaceLeaseGuardLayer
} from "../agent/internal/PrReviewSourceWorkspace.js"
import { ApiBindConfiguration } from "../api/ApiConfiguration.js"
import type {
  AuthorizedShares,
  CodePipelineReads,
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
import { governedReviewSuggestionPublicationGatewayLayer } from "../application/GovernedReviewSuggestionPublicationGateway.js"
import {
  authorizedSharesLayer,
  codePipelineReadsLayer,
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
import { reviewSuggestionPublicationGatewayUnavailableLayer } from "../application/ReviewSuggestionPublicationGateway.js"
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
import type { AgentLeaseOwner } from "../persistence/repositories/agentJobModels.js"
import { AgentJobRepository } from "../persistence/repositories/agentJobRepository.js"
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
import {
  firstPartyPluginConnectionMapLayer,
  firstPartyPluginRuntimeLayers,
  firstPartyPluginRuntimeLayersFromRegistry,
  firstPartyPluginRuntimeRegistryLayer,
  type FirstPartyPluginRuntimeRegistryOverride
} from "./FirstPartyPluginRuntime.js"
import {
  governedActionExecutionRuntimeFromRuntimeMapLayers,
  GovernedActionExecutionStartup,
  type GovernedActionExecutionStartupError,
  governedActionExecutionStartupLayer,
  type GovernedActionExecutionStartupOptions,
  governedActionPolicyBindingSourceLayer,
  governedActionProposalAuthorityLiveLayer,
  governedActionSubmissionLayer
} from "./GovernedActionExecutionStartup.js"
import {
  type DirectTlsServerError,
  makeNodeTransportLayer,
  nodeOutboundHttpClientLayer,
  nodeSecretPlatformLayer
} from "./NodeTransport.js"
import { prReviewWorkerStartupLayer, type PrReviewWorkerStartupOptions } from "./PrReviewWorkerStartup.js"
import {
  type ReleaseSynchronizationStartupError,
  releaseSynchronizationStartupLayer,
  type ReleaseSynchronizationStartupOptions
} from "./ReleaseSynchronizationStartup.js"
import { requestUrlBoundaryLayer } from "./RequestUrlBoundary.js"
import { ServerLifecycle } from "./ServerLifecycle.js"

type ControlCenterCoreApplicationServices =
  | AuthorizedShares
  | CodePipelineReads
  | CompleteDiffReads
  | DeliveryGraphInspection
  | MediaReads
  | PluginAdministration
  | PortfolioSnapshots
  | RelationshipRepairProposals
  | TimelineExportAudits
  | TimelineReads

/** Explicit production review worker; absence keeps review capability unavailable. */
export interface ControlCenterPrReviewWorkerOptions {
  readonly workspaceId: PrReviewWorkerStartupOptions["workspaceId"]
  readonly workspaceRoot: string
  readonly sbxExecutable?: string
  readonly sbxTemplate?: string
  /** Codex executable available inside the native review sandbox. */
  readonly codexExecutable?: string
  /** Claude executable available inside the native review sandbox. */
  readonly claudeExecutable?: string
  readonly reviewBudgetMillis?: number
  readonly leaseOwner: AgentLeaseOwner
  readonly leaseDuration?: Duration.Input
  readonly idlePollInterval?: Duration.Input
  readonly failurePollInterval?: Duration.Input
  /** Deterministic composition-test hook; production omits it. @internal */
  readonly runOnceBeforeSupervision?: boolean
  readonly maximumSandboxDurationMillis?: number
  readonly maximumSourceDuration?: Duration.Input
  /** Deterministic composition seam; production omits it. @internal */
  readonly sourceWorkspace?: PrReviewSourceWorkspace["Service"]
  /** Deterministic composition seam; production omits it. @internal */
  readonly sandboxSessions?: PrReviewSandboxSessions["Service"]
}

/** Runtime construction settings after security and persistence decoding. */
export interface ControlCenterServerOptions<ApplicationError = never, ApplicationRequirements = never> {
  readonly bindConfig: BindConfig
  readonly persistenceConfig: PersistenceConfig
  /** Scoped first-party provider runtimes used by live connection checks. */
  readonly pluginConnections?: PluginConnectionMapV1 | null
  /** Enable the fixed production provider registry when no test map is injected. */
  readonly firstPartyPluginRuntime?: boolean | undefined
  /** Deterministic first-party registry seam; production omits it. @internal */
  readonly firstPartyPluginRuntimes?: FirstPartyPluginRuntimeRegistryOverride | undefined
  readonly secretRoot: SecretRoot
  readonly staticAssets: StaticAssetStoreOptions
  /** Deterministic outbound transport seam; production omits it. @internal */
  readonly outboundHttpClient?: HttpClient.HttpClient
  readonly bootstrap?: ControlCenterBootstrapOptions | null
  readonly releaseSynchronization?: ReleaseSynchronizationStartupOptions | null
  readonly releaseAgent?: ReleaseAgentRuntimeOptions | null
  /** Opt-in immutable PR-review source, sandbox, and durable worker composition. */
  readonly prReviewWorker?: ControlCenterPrReviewWorkerOptions | null
  readonly governedActionExecution?:
    | (
      & Pick<GovernedActionExecutionStartupOptions, "workspaceId">
      & { readonly pluginRuntimes?: GovernedActionExecutionStartupOptions["pluginRuntimes"] }
    )
    | null
  readonly applicationServices?: Layer.Layer<
    ControlCenterCoreApplicationServices,
    ApplicationError,
    ApplicationRequirements | Persistence | SecretStore
  >
}

/** Invalid production review composition rejected before a worker can claim durable work. */
export class PrReviewWorkerConfigurationError extends Schema.TaggedErrorClass<
  PrReviewWorkerConfigurationError
>()("PrReviewWorkerConfigurationError", {
  diagnosticCode: Schema.Literal("review-provider-required")
}) {}

/** Failures that can prevent the runtime from acquiring or listening. */
export type ControlCenterServerError<ApplicationError = never> =
  | ApplicationError
  | ControlCenterBootstrapError
  | DirectTlsServerError
  | GovernedActionExecutionStartupError
  | PersistenceLayerError
  | PrReviewWorkerConfigurationError
  | PrReviewSandboxSessionError
  | PrReviewSourceError
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
    return Layer.mergeAll(
      pluginAdministrationOAuthLayerWithConnections(pluginConnections, publicOrigin),
      completeDiffReadsLayer(pluginConnections),
      codePipelineReadsLayer(pluginConnections)
    )
  }
  if (!firstPartyPluginRuntime) {
    return Layer.mergeAll(
      pluginAdministrationOAuthLayer(publicOrigin),
      completeDiffReadsLayer(null),
      codePipelineReadsLayer(null)
    )
  }
  return Layer.unwrap(
    Effect.map(
      PluginConnectionMap,
      (connections) =>
        Layer.mergeAll(
          pluginAdministrationOAuthLayerWithConnections(connections, publicOrigin),
          completeDiffReadsLayer(connections),
          codePipelineReadsLayer(connections)
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
  const configuredPluginConnections = options.pluginConnections ?? options.releaseSynchronization?.pluginConnections ??
    null
  const firstPartyPluginRuntime = options.firstPartyPluginRuntime ?? false
  const firstPartyRuntime = firstPartyPluginRuntime
    ? options.firstPartyPluginRuntimes === undefined
      ? firstPartyPluginRuntimeLayers(firstPartyPluginRuntimeRegistryLayer)
      : firstPartyPluginRuntimeLayersFromRegistry(options.firstPartyPluginRuntimes)
    : null
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
    configuredPluginConnections,
    firstPartyPluginRuntime,
    options.bindConfig.publicOrigin,
    firstPartyRuntime?.connections ?? firstPartyPluginConnectionMapLayer
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
          : { openAiCompatible: options.releaseAgent.openAiCompatible }),
        ...(options.prReviewWorker === undefined || options.prReviewWorker === null
          ? {}
          : {
            prReviewEnabled: true,
            ...(options.prReviewWorker.codexExecutable === undefined
              ? {}
              : { prReviewCodexExecutable: options.prReviewWorker.codexExecutable }),
            ...(options.prReviewWorker.claudeExecutable === undefined
              ? {}
              : { prReviewClaudeExecutable: options.prReviewWorker.claudeExecutable }),
            ...(options.prReviewWorker.reviewBudgetMillis === undefined
              ? {}
              : { prReviewBudgetMillis: options.prReviewWorker.reviewBudgetMillis })
          })
      }
  )
  const releaseAgentJobs = releaseAgentJobsLayer.pipe(
    Layer.provide(providerRegistry),
    Layer.provide(persistence)
  )
  const governedActionConfiguration = options.governedActionExecution ?? null
  const governedActionExecutionReady = governedActionConfiguration !== null &&
    (governedActionConfiguration.pluginRuntimes !== undefined || firstPartyPluginRuntime)
  const firstPartyGovernedActionRuntime = governedActionConfiguration !== null &&
      governedActionConfiguration.pluginRuntimes === undefined &&
      firstPartyPluginRuntime
    ? governedActionExecutionRuntimeFromRuntimeMapLayers(governedActionConfiguration.workspaceId)
    : null
  const firstPartyGovernedActionStartup = governedActionConfiguration !== null &&
      governedActionConfiguration.pluginRuntimes === undefined &&
      firstPartyPluginRuntime
    ? firstPartyGovernedActionRuntime!.startup.pipe(
      Layer.provide(firstPartyRuntime!.runtimeMap)
    )
    : null
  const firstPartyGovernedActionExecutors = firstPartyGovernedActionRuntime === null
    ? null
    : firstPartyGovernedActionRuntime.executors.pipe(
      Layer.provide(firstPartyRuntime!.runtimeMap)
    )
  const governedActionStartupBase = governedActionConfiguration === null
    ? governedActionExecutionStartupLayer(null)
    : governedActionConfiguration.pluginRuntimes === undefined
    ? firstPartyPluginRuntime
      ? firstPartyGovernedActionStartup!
      : governedActionExecutionStartupLayer(null)
    : governedActionExecutionStartupLayer({
      workspaceId: governedActionConfiguration.workspaceId,
      pluginRuntimes: governedActionConfiguration.pluginRuntimes
    })
  const governedActionStartup = governedActionStartupBase.pipe(Layer.provide(database))
  const governedActionSubmission = governedActionSubmissionLayer.pipe(
    Layer.provide(governedActionStartup)
  )
  const publicationConnections = configuredPluginConnections === null
    ? firstPartyPluginRuntime
      ? firstPartyRuntime!.connections.pipe(Layer.provide(database))
      : null
    : Layer.succeed(PluginConnectionMap, configuredPluginConnections)
  const reviewSuggestionPublications = !governedActionExecutionReady || publicationConnections === null
    ? reviewSuggestionPublicationGatewayUnavailableLayer
    : governedReviewSuggestionPublicationGatewayLayer.pipe(
      Layer.provide(governedActionSubmission),
      Layer.provide(governedActionPolicyBindingSourceLayer),
      Layer.provide(governedActionProposalAuthorityLiveLayer.pipe(Layer.provide(database))),
      Layer.provide(publicationConnections),
      Layer.provide(persistence)
    )
  const pullRequestReviews = pullRequestReviewsLayer.pipe(
    Layer.provide(providerRegistry),
    Layer.provide(reviewSuggestionPublications),
    Layer.provide(persistence),
    Layer.provide(applicationServices)
  )
  const liveEventRuntime = liveEventsLayer.pipe(
    Layer.provide(applicationServices),
    Layer.provide(persistence),
    Layer.provideMerge(domainEventWakeups)
  )
  const governedActionExecution = Layer.effectDiscard(GovernedActionExecutionStartup).pipe(
    Layer.provide(governedActionStartup)
  )
  const prReviewWorker = options.prReviewWorker === undefined || options.prReviewWorker === null
    ? Layer.empty
    : options.releaseAgent === undefined ||
        options.releaseAgent === null ||
        (
          options.releaseAgent.openAiCompatible === undefined &&
          !options.releaseAgent.enabledProviders.includes("codex") &&
          !options.releaseAgent.enabledProviders.includes("claude")
        )
    ? Layer.effectDiscard(
      Effect.fail(
        new PrReviewWorkerConfigurationError({
          diagnosticCode: "review-provider-required"
        })
      )
    )
    : (() => {
      const configured = options.prReviewWorker
      const sourceWorkspace = configured.sourceWorkspace === undefined
        ? prReviewSourceWorkspaceLayer({
          workspaceRoot: configured.workspaceRoot,
          ...(configured.maximumSourceDuration === undefined
            ? {}
            : { maximumDuration: configured.maximumSourceDuration })
        }).pipe(
          Layer.provide(codeCommitPrReviewSourceResolverLayer.pipe(Layer.provide(persistence))),
          Layer.provide(
            prReviewWorkspaceLeaseGuardLayer(configured.workspaceId).pipe(
              Layer.provide(AgentJobRepository.layer.pipe(Layer.provide(database)))
            )
          )
        )
        : Layer.succeed(PrReviewSourceWorkspace, configured.sourceWorkspace)
      const sandboxes = configured.sandboxSessions === undefined
        ? prReviewSandboxSessionsLayer({
          ...(configured.sbxExecutable === undefined ? {} : { executable: configured.sbxExecutable }),
          ...(configured.sbxTemplate === undefined ? {} : { template: configured.sbxTemplate }),
          ...(configured.maximumSandboxDurationMillis === undefined
            ? {}
            : { maximumSessionDurationMillis: configured.maximumSandboxDurationMillis })
        }).pipe(Layer.provide(sourceWorkspace))
        : Layer.succeed(PrReviewSandboxSessions, configured.sandboxSessions)
      const repository = AgentJobRepository.layer.pipe(Layer.provide(database))
      const workerOptions: AgentJobWorkerOptions = {
        leaseOwner: configured.leaseOwner,
        leaseDuration: configured.leaseDuration ?? "5 minutes"
      }
      const worker = prReviewAgentJobWorkerLayer(workerOptions).pipe(
        Layer.provide(providerRegistry),
        Layer.provide(sandboxes),
        Layer.provide(repository)
      )
      return prReviewWorkerStartupLayer({
        workspaceId: configured.workspaceId,
        ...(configured.idlePollInterval === undefined
          ? {}
          : { idlePollInterval: configured.idlePollInterval }),
        ...(configured.failurePollInterval === undefined
          ? {}
          : { failurePollInterval: configured.failurePollInterval }),
        ...(configured.runOnceBeforeSupervision === undefined
          ? {}
          : { runOnceBeforeSupervision: configured.runOnceBeforeSupervision })
      }).pipe(
        Layer.provide(worker),
        Layer.provide(sandboxes)
      )
    })()
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
    prReviewWorker,
    releaseSynchronizationStartupLayer(options.releaseSynchronization ?? null).pipe(
      Layer.provideMerge(controlCenterBootstrapLayer(options.bootstrap ?? null))
    )
  )
  return {
    application: routes.pipe(Layer.provideMerge(runtimeServices)),
    applicationServices,
    firstPartyGovernedActionExecutors,
    firstPartyGovernedActionStartup,
    firstPartyRuntime,
    governedActionStartup,
    lifecycle,
    reviewSuggestionPublications,
    runtimeServices
  }
}

/** Inspect the exact application composition in focused ownership tests. @internal */
export const makeControlCenterApplicationComposition = <
  ApplicationError = never,
  ApplicationRequirements = never
>(
  options: ControlCenterServerOptions<ApplicationError, ApplicationRequirements>
): ReturnType<typeof makeApplication<ApplicationError, ApplicationRequirements>> => makeApplication(options)

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
  const outboundHttpClient = options.outboundHttpClient === undefined
    ? nodeOutboundHttpClientLayer
    : Layer.succeed(HttpClient.HttpClient, options.outboundHttpClient)
  const application = makeApplication(options)
  const server = HttpRouter.serve(application.application, { disableLogger: true }).pipe(
    Layer.provide(application.runtimeServices),
    Layer.provide(transport),
    Layer.provide(secrets),
    Layer.provide(outboundHttpClient),
    Layer.provideMerge(application.lifecycle)
  )
  return server
}

/** Construct the fully runnable Node HTTP/HTTPS server layer. */
export const makeControlCenterServer = <ApplicationError = never, ApplicationRequirements = never>(
  options: ControlCenterServerOptions<ApplicationError, ApplicationRequirements>
): ReturnType<typeof makeServer<ApplicationError, ApplicationRequirements>> => makeServer(options)
