import type { FileSystem, Path } from "effect"
import { Context, Crypto, Effect, Layer, Predicate, Result } from "effect"
import type { Success } from "effect/Effect"

import type { BackupFailure, SchemaWriteBarrierError } from "./backup/index.js"
import { ContentStore, type ContentStoreService, type ReproduciblePutContentInput } from "./ContentStore.js"
import { Database, databaseLayer, type DatabaseShape } from "./Database.js"
import {
  type ContentMetadataMismatchError,
  type DatabaseInitializationError,
  type PersistedRecordError,
  type PersistenceConfigError,
  PersistenceOperationError,
  type PluginConnectionLimitError,
  type QuarantineWriteError,
  type RecordAlreadyExistsError,
  type RecordNotFoundError,
  type ReproducibleContentUnavailableError,
  type RevisionConflictError,
  type SecretReferenceScopeConflictError,
  type SourceIdentityMismatchError,
  type WorkspaceSettingsGovernanceError,
  type WorkspaceSettingsMutationConflictError,
  type WorkspaceSettingsNoChangesError
} from "./errors.js"
import { BlobStore } from "./object-store/BlobStore.js"
import type { BlobStoreError } from "./object-store/BlobStoreError.js"
import { decodePersistenceConfig } from "./PersistenceConfig.js"
import {
  type AgentJobInputError,
  AgentJobRepository,
  type AgentJobRepositoryService,
  type AuthorizedShareInputError,
  AuthorizedShareRepository,
  type AuthorizedShareRepositoryService,
  ContentBlobMetadataRepository,
  type DeliveryGraphInputError,
  DeliveryGraphRepository,
  type DeliveryGraphRepositoryService,
  DiffContentCacheRepository,
  type DiffContentCacheRepositoryService,
  DomainEventRepository,
  type DomainEventRepositoryService,
  EntityRepository,
  type EntityRepositoryService,
  type GovernedActionInputError,
  GovernedActionRepository,
  type GovernedActionRepositoryService,
  PeopleRepository,
  type PeopleRepositoryService,
  PluginConfigurationRepository,
  type PluginConfigurationRepositoryService,
  PluginConnectionRepository,
  type PluginConnectionRepositoryService,
  PluginRuntimeRepository,
  type PluginRuntimeRepositoryService,
  type ProviderAccountInputError,
  ProviderAccountRepository,
  type ProviderAccountRepositoryService,
  QuarantineRepository,
  type ReadinessInputError,
  ReadinessRepository,
  type ReadinessRepositoryService,
  type RelationshipRepairProposalInputError,
  RelationshipRepairProposalRepository,
  type RelationshipRepairProposalRepositoryService,
  ReleaseRepository,
  type ReleaseRepositoryService,
  RetentionRepository,
  type RetentionRepositoryService,
  type TimelineExportAuditInputError,
  TimelineExportAuditRepository,
  type TimelineExportAuditRepositoryService,
  TimelineRepository,
  type TimelineRepositoryService,
  WorkspaceRepository,
  type WorkspaceRepositoryService,
  WorkspaceSettingsRepository,
  type WorkspaceSettingsRepositoryService
} from "./repositories/index.js"
import { mapPersistenceOperation } from "./repositories/internal.js"

/** Typed failures that may cross the public persistence operation boundary. */
export type PersistenceOperationFailure =
  | AgentJobInputError
  | AuthorizedShareInputError
  | BlobStoreError
  | ContentMetadataMismatchError
  | DeliveryGraphInputError
  | GovernedActionInputError
  | PersistedRecordError
  | PluginConnectionLimitError
  | ProviderAccountInputError
  | PersistenceOperationError
  | QuarantineWriteError
  | ReadinessInputError
  | RelationshipRepairProposalInputError
  | RecordAlreadyExistsError
  | RecordNotFoundError
  | ReproducibleContentUnavailableError
  | RevisionConflictError
  | SecretReferenceScopeConflictError
  | SourceIdentityMismatchError
  | TimelineExportAuditInputError
  | WorkspaceSettingsGovernanceError
  | WorkspaceSettingsMutationConflictError
  | WorkspaceSettingsNoChangesError

const PUBLIC_OPERATION_ERROR_TAGS = new Set([
  "AgentJobInputError",
  "AuthorizedShareInputError",
  "BlobContainmentError",
  "BlobIntegrityError",
  "BlobNotFoundError",
  "BlobStoreInputError",
  "BlobStoreIoError",
  "BlobTooLargeError",
  "BlobUnexpectedEofError",
  "ContentMetadataMismatchError",
  "DeliveryGraphInputError",
  "GovernedActionInputError",
  "PersistedRecordError",
  "PluginConnectionLimitError",
  "ProviderAccountInputError",
  "PersistenceOperationError",
  "QuarantineWriteError",
  "ReadinessInputError",
  "RelationshipRepairProposalInputError",
  "RecordAlreadyExistsError",
  "RecordNotFoundError",
  "ReproducibleContentUnavailableError",
  "RevisionConflictError",
  "SecretReferenceScopeConflictError",
  "SourceIdentityMismatchError",
  "TimelineExportAuditInputError",
  "WorkspaceSettingsGovernanceError",
  "WorkspaceSettingsMutationConflictError",
  "WorkspaceSettingsNoChangesError"
])

const isPersistenceOperationFailure = (error: unknown): error is PersistenceOperationFailure =>
  Predicate.hasProperty(error, "_tag") &&
  typeof error._tag === "string" &&
  PUBLIC_OPERATION_ERROR_TAGS.has(error._tag)

const publicOperation = <Value, Failure, Requirements>(
  operation: string,
  effect: Effect.Effect<Value, Failure, Requirements>
): Effect.Effect<Value, PersistenceOperationFailure, Requirements> =>
  Effect.catch(
    effect,
    (error): Effect.Effect<never, PersistenceOperationFailure> =>
      isPersistenceOperationFailure(error)
        ? Effect.fail<PersistenceOperationFailure>(error)
        : Effect.logError("Control Center persistence boundary rejected an internal error", {
          operation
        }).pipe(
          Effect.andThen(
            Effect.fail<PersistenceOperationFailure>(new PersistenceOperationError({ operation }))
          )
        )
  )

/** Reclaim a bounded durable batch while publication holds the same writer lock. */
export const sweepDiffContentCacheCleanup = Effect.fn("Persistence.sweepDiffContentCacheCleanup")(
  function*(
    database: DatabaseShape,
    content: Pick<ContentStoreService, "removeReproducible">,
    diffContentCache: DiffContentCacheRepositoryService
  ) {
    const candidates = yield* diffContentCache.pendingCleanup()
    for (const candidate of candidates) {
      yield* database.transaction(
        Effect.gen(function*() {
          yield* database.sql`UPDATE workspaces
            SET workspace_id = workspace_id
            WHERE workspace_id = ${candidate.workspaceId}`
          if (yield* diffContentCache.isReferenced(candidate.workspaceId, candidate.digest)) {
            yield* diffContentCache.cancelCleanup(candidate.workspaceId, candidate.digest)
            return
          }
          yield* content.removeReproducible(candidate.workspaceId, candidate.digest)
          yield* diffContentCache.completeCleanup(candidate.workspaceId, candidate.digest)
        })
      ).pipe(
        mapPersistenceOperation("diff-content-cache.cleanup"),
        Effect.catch(() =>
          diffContentCache.deferCleanup(candidate.workspaceId, candidate.digest).pipe(
            Effect.catch(() => Effect.logWarning("A diff content cache cleanup retry could not be rescheduled")),
            Effect.andThen(
              Effect.logWarning("One deferred diff content cache cleanup remains pending")
            )
          )
        )
      )
    }
  }
)

/** Keep deferred blob reclamation outside the outcome of an already committed write. @internal */
export const completeDeferredCleanupBestEffort = Effect.fn(
  "Persistence.completeDeferredCleanupBestEffort"
)(function*<Requirements>(
  cleanup: Effect.Effect<void, unknown, Requirements>
) {
  yield* cleanup.pipe(
    Effect.catch(() =>
      Effect.logWarning(
        "Deferred diff content cache cleanup remains pending for a later retry"
      )
    )
  )
})

/** Publish a mapping, persist orphan intent even on failure, then drain one retryable batch. */
export const putAndSweepDiffContentCache = Effect.fn("Persistence.putAndSweepDiffContentCache")(
  function*(
    database: DatabaseShape,
    content: ContentStoreService,
    diffContentCache: DiffContentCacheRepositoryService,
    ...args: Parameters<DiffContentCacheRepositoryService["put"]>
  ) {
    const [key, digest] = args
    const publication = yield* Effect.uninterruptible(
      database.transaction(
        Effect.gen(function*() {
          yield* database.sql`UPDATE workspaces
            SET workspace_id = workspace_id
            WHERE workspace_id = ${key.workspaceId}`
          const requestResult = yield* diffContentCache.requestCleanup(
            key.workspaceId,
            digest
          ).pipe(Effect.result)
          const putResult = yield* diffContentCache.put(...args).pipe(Effect.result)
          return { requestResult, putResult }
        })
      ).pipe(mapPersistenceOperation("diff-content-cache.publish"))
    )
    const cleanupResult = yield* sweepDiffContentCacheCleanup(
      database,
      content,
      diffContentCache
    ).pipe(Effect.result)
    if (Result.isFailure(publication.requestResult)) return yield* publication.requestResult.failure
    if (Result.isFailure(publication.putResult)) return yield* publication.putResult.failure
    if (Result.isFailure(cleanupResult)) return yield* cleanupResult.failure
    return yield* Effect.void
  }
)

/** Atomically publish metadata, cleanup intent, and the diff ownership mapping. */
export const putContentAndSweepDiffContentCache = Effect.fn(
  "Persistence.putContentAndSweepDiffContentCache"
)(function*(
  database: DatabaseShape,
  content: ContentStoreService,
  diffContentCache: DiffContentCacheRepositoryService,
  key: Parameters<DiffContentCacheRepositoryService["put"]>[0],
  input: ReproduciblePutContentInput
) {
  const staged = yield* Effect.uninterruptible(
    database.transaction(
      Effect.gen(function*() {
        yield* database.sql`UPDATE workspaces
          SET workspace_id = workspace_id
          WHERE workspace_id = ${key.workspaceId}`
        const published = yield* content.put(key.workspaceId, input)
        yield* diffContentCache.requestCleanup(
          key.workspaceId,
          published.metadata.digest
        )
        const putResult = yield* diffContentCache.put(
          key,
          published.metadata.digest
        ).pipe(Effect.result)
        return { published, putResult }
      })
    ).pipe(mapPersistenceOperation("diff-content-cache.stage-content"))
  )
  const cleanupResult = yield* sweepDiffContentCacheCleanup(
    database,
    content,
    diffContentCache
  ).pipe(Effect.result)
  if (Result.isFailure(staged.putResult)) return yield* staged.putResult.failure
  if (Result.isFailure(cleanupResult)) return yield* cleanupResult.failure
  return staged.published
})

/** Failures possible while acquiring the durable persistence service. */
export type PersistenceLayerError =
  | BackupFailure
  | BlobStoreError
  | DatabaseInitializationError
  | SchemaWriteBarrierError
  | PersistenceConfigError

const makePersistence = Effect.gen(function*() {
  const cryptoService = yield* Crypto.Crypto
  const database = yield* Database
  const agentJobs = yield* AgentJobRepository
  const authorizedShares = yield* AuthorizedShareRepository
  const content = yield* ContentStore
  const diffContentCache = yield* DiffContentCacheRepository
  const deliveryGraph = yield* DeliveryGraphRepository
  const events = yield* DomainEventRepository
  const governedActions = yield* GovernedActionRepository
  const entities = yield* EntityRepository
  const people = yield* PeopleRepository
  const pluginConnections = yield* PluginConnectionRepository
  const pluginConfigurations = yield* PluginConfigurationRepository
  const pluginRuntime = yield* PluginRuntimeRepository
  const providerAccounts = yield* ProviderAccountRepository
  const readiness = yield* ReadinessRepository
  const relationshipRepairProposals = yield* RelationshipRepairProposalRepository
  const releases = yield* ReleaseRepository
  const retention = yield* RetentionRepository
  const timeline = yield* TimelineRepository
  const timelineExportAudits = yield* TimelineExportAuditRepository
  const workspaces = yield* WorkspaceRepository
  const workspaceSettings = yield* WorkspaceSettingsRepository

  yield* completeDeferredCleanupBestEffort(
    sweepDiffContentCacheCleanup(database, content, diffContentCache)
  )

  return {
    agentJobs: {
      appendEvent: (...args: Parameters<AgentJobRepositoryService["appendEvent"]>) =>
        publicOperation("agent-job.append-event", agentJobs.appendEvent(...args)),
      appendReviewSuggestionRevision: (
        ...args: Parameters<
          AgentJobRepositoryService["appendReviewSuggestionRevision"]
        >
      ) =>
        publicOperation(
          "agent-job.append-review-suggestion-revision",
          agentJobs.appendReviewSuggestionRevision(...args)
        ),
      claimNext: (...args: Parameters<AgentJobRepositoryService["claimNext"]>) =>
        publicOperation("agent-job.claim-next", agentJobs.claimNext(...args)),
      completeReview: (...args: Parameters<AgentJobRepositoryService["completeReview"]>) =>
        publicOperation("agent-job.complete-review", agentJobs.completeReview(...args)),
      recordReviewProgress: (...args: Parameters<AgentJobRepositoryService["recordReviewProgress"]>) =>
        publicOperation("agent-job.record-review-progress", agentJobs.recordReviewProgress(...args)),
      enqueue: (...args: Parameters<AgentJobRepositoryService["enqueue"]>) =>
        publicOperation("agent-job.enqueue", agentJobs.enqueue(...args)),
      failAttempt: (...args: Parameters<AgentJobRepositoryService["failAttempt"]>) =>
        publicOperation("agent-job.fail-attempt", agentJobs.failAttempt(...args)),
      latestReview: (...args: Parameters<AgentJobRepositoryService["latestReview"]>) =>
        publicOperation("agent-job.latest-review", agentJobs.latestReview(...args)),
      latestReviewForPullRequest: (
        ...args: Parameters<AgentJobRepositoryService["latestReview"]>
      ) =>
        publicOperation(
          "agent-job.latest-review-for-pull-request",
          agentJobs.latestReview({ ...args[0], allowDifferentHead: true })
        ),
      listRunningPrReviewAttempts: (
        ...args: Parameters<AgentJobRepositoryService["listRunningPrReviewAttempts"]>
      ) =>
        publicOperation(
          "agent-job.list-running-pr-review-attempts",
          agentJobs.listRunningPrReviewAttempts(...args)
        ),
      attachRunningPrReviewSession: (
        ...args: Parameters<AgentJobRepositoryService["attachRunningPrReviewSession"]>
      ) =>
        publicOperation(
          "agent-job.attach-running-pr-review-session",
          agentJobs.attachRunningPrReviewSession(...args)
        ),
      readReviewSuggestionPublication: (
        ...args: Parameters<AgentJobRepositoryService["readReviewSuggestionPublication"]>
      ) =>
        publicOperation(
          "agent-job.read-review-suggestion-publication",
          agentJobs.readReviewSuggestionPublication(...args)
        ),
      releaseReviewSuggestionPublication: (
        ...args: Parameters<AgentJobRepositoryService["releaseReviewSuggestionPublication"]>
      ) =>
        publicOperation(
          "agent-job.release-review-suggestion-publication",
          agentJobs.releaseReviewSuggestionPublication(...args)
        ),
      reserveReviewSuggestionPublication: (
        ...args: Parameters<AgentJobRepositoryService["reserveReviewSuggestionPublication"]>
      ) =>
        publicOperation(
          "agent-job.reserve-review-suggestion-publication",
          agentJobs.reserveReviewSuggestionPublication(...args)
        ),
      recordReviewSuggestionPublication: (
        ...args: Parameters<AgentJobRepositoryService["recordReviewSuggestionPublication"]>
      ) =>
        publicOperation(
          "agent-job.record-review-suggestion-publication",
          agentJobs.recordReviewSuggestionPublication(...args)
        ),
      reviewBudget: (...args: Parameters<AgentJobRepositoryService["reviewBudget"]>) =>
        publicOperation("agent-job.review-budget", agentJobs.reviewBudget(...args)),
      requestCancellation: (...args: Parameters<AgentJobRepositoryService["requestCancellation"]>) =>
        publicOperation("agent-job.request-cancellation", agentJobs.requestCancellation(...args)),
      extendReviewBudget: (...args: Parameters<AgentJobRepositoryService["extendReviewBudget"]>) =>
        publicOperation("agent-job.extend-review-budget", agentJobs.extendReviewBudget(...args)),
      interruptRunningReviews: (
        ...args: Parameters<AgentJobRepositoryService["interruptRunningReviews"]>
      ) =>
        publicOperation(
          "agent-job.interrupt-running-reviews",
          agentJobs.interruptRunningReviews(...args)
        ),
      reviewThreadAfter: (...args: Parameters<AgentJobRepositoryService["reviewThreadAfter"]>) =>
        publicOperation("agent-job.review-thread-after", agentJobs.reviewThreadAfter(...args)),
      reviewThreadBefore: (...args: Parameters<AgentJobRepositoryService["reviewThreadBefore"]>) =>
        publicOperation("agent-job.review-thread-before", agentJobs.reviewThreadBefore(...args)),
      reviewThreadTail: (...args: Parameters<AgentJobRepositoryService["reviewThreadTail"]>) =>
        publicOperation("agent-job.review-thread-tail", agentJobs.reviewThreadTail(...args)),
      reviewResult: (...args: Parameters<AgentJobRepositoryService["reviewResult"]>) =>
        publicOperation("agent-job.review-result", agentJobs.reviewResult(...args)),
      reviewSuggestionRevisions: (
        ...args: Parameters<AgentJobRepositoryService["reviewSuggestionRevisions"]>
      ) =>
        publicOperation(
          "agent-job.review-suggestion-revisions",
          agentJobs.reviewSuggestionRevisions(...args)
        ),
      threadAfter: (...args: Parameters<AgentJobRepositoryService["threadAfter"]>) =>
        publicOperation("agent-job.thread-after", agentJobs.threadAfter(...args))
    },
    authorizedShares: {
      create: (...args: Parameters<AuthorizedShareRepositoryService["create"]>) =>
        publicOperation("authorized-share.create", authorizedShares.create(...args)),
      get: (...args: Parameters<AuthorizedShareRepositoryService["get"]>) =>
        publicOperation("authorized-share.get", authorizedShares.get(...args)),
      revoke: (...args: Parameters<AuthorizedShareRepositoryService["revoke"]>) =>
        publicOperation("authorized-share.revoke", authorizedShares.revoke(...args))
    },
    transact: <Success, Failure, Requirements>(
      effect: Effect.Effect<Success, Failure, Requirements>
    ) => database.transaction(effect).pipe(mapPersistenceOperation("persistence.transaction")),
    content: {
      put: (...args: Parameters<ContentStoreService["put"]>) => publicOperation("content.put", content.put(...args)),
      getMetadata: (...args: Parameters<ContentStoreService["getMetadata"]>) =>
        publicOperation("content.get-metadata", content.getMetadata(...args)),
      listMetadata: (...args: Parameters<ContentStoreService["listMetadata"]>) =>
        publicOperation("content.list-metadata", content.listMetadata(...args)),
      readAll: (...args: Parameters<ContentStoreService["readAll"]>) =>
        publicOperation("content.read-all", content.readAll(...args)),
      readRange: (...args: Parameters<ContentStoreService["readRange"]>) =>
        publicOperation("content.read-range", content.readRange(...args)),
      readStream: (...args: Parameters<ContentStoreService["readStream"]>) =>
        publicOperation("content.read-stream", content.readStream(...args)),
      verify: (...args: Parameters<ContentStoreService["verify"]>) =>
        publicOperation("content.verify", content.verify(...args))
    },
    diffContentCache: {
      get: (...args: Parameters<DiffContentCacheRepositoryService["get"]>) =>
        publicOperation("diff-content-cache.get", diffContentCache.get(...args)),
      put: (...args: Parameters<DiffContentCacheRepositoryService["put"]>) =>
        publicOperation(
          "diff-content-cache.put",
          putAndSweepDiffContentCache(database, content, diffContentCache, ...args).pipe(Effect.asVoid)
        ),
      putContent: (
        key: Parameters<DiffContentCacheRepositoryService["put"]>[0],
        input: ReproduciblePutContentInput
      ) =>
        publicOperation(
          "diff-content-cache.put-content",
          putContentAndSweepDiffContentCache(
            database,
            content,
            diffContentCache,
            key,
            input
          )
        )
    },
    deliveryGraph: {
      read: (...args: Parameters<DeliveryGraphRepositoryService["read"]>) =>
        publicOperation("delivery-graph.read", deliveryGraph.read(...args)),
      write: (...args: Parameters<DeliveryGraphRepositoryService["write"]>) =>
        publicOperation("delivery-graph.write", deliveryGraph.write(...args))
    },
    entities: {
      create: (...args: Parameters<EntityRepositoryService["create"]>) =>
        publicOperation("entity.create", entities.create(...args)),
      findBySourceIdentity: (...args: Parameters<EntityRepositoryService["findBySourceIdentity"]>) =>
        publicOperation("entity.find-by-source-identity", entities.findBySourceIdentity(...args)),
      get: (...args: Parameters<EntityRepositoryService["get"]>) =>
        publicOperation("entity.get", entities.get(...args)),
      list: (...args: Parameters<EntityRepositoryService["list"]>) =>
        publicOperation("entity.list", entities.list(...args)),
      updateSourceRevision: (...args: Parameters<EntityRepositoryService["updateSourceRevision"]>) =>
        publicOperation("entity.update", entities.updateSourceRevision(...args))
    },
    events: {
      append: (...args: Parameters<DomainEventRepositoryService["append"]>) =>
        publicOperation("domain-event.append", events.append(...args)),
      pageAfter: (...args: Parameters<DomainEventRepositoryService["pageAfter"]>) =>
        publicOperation("domain-event.page-after", events.pageAfter(...args)),
      prune: (...args: Parameters<DomainEventRepositoryService["prune"]>) =>
        publicOperation("domain-event.prune", events.prune(...args)),
      streamState: (...args: Parameters<DomainEventRepositoryService["streamState"]>) =>
        publicOperation("domain-event.stream-state", events.streamState(...args))
    },
    governedActions: {
      commit: (...args: Parameters<GovernedActionRepositoryService["commit"]>) =>
        publicOperation("governed-action.commit", governedActions.commit(...args)),
      read: (...args: Parameters<GovernedActionRepositoryService["read"]>) =>
        publicOperation("governed-action.read", governedActions.read(...args)),
      readByIdempotencyKey: (
        ...args: Parameters<GovernedActionRepositoryService["readByIdempotencyKey"]>
      ) =>
        publicOperation(
          "governed-action.read-by-idempotency-key",
          governedActions.readByIdempotencyKey(...args)
        ),
      readLatestTerminalByTarget: (
        ...args: Parameters<GovernedActionRepositoryService["readLatestTerminalByTarget"]>
      ) =>
        publicOperation(
          "governed-action.read-latest-terminal-by-target",
          governedActions.readLatestTerminalByTarget(...args)
        )
    },
    people: {
      createPerson: (...args: Parameters<PeopleRepositoryService["createPerson"]>) =>
        publicOperation("people.create-person", people.createPerson(...args)),
      createRoleAssignment: (...args: Parameters<PeopleRepositoryService["createRoleAssignment"]>) =>
        publicOperation("people.create-role", people.createRoleAssignment(...args)),
      getPerson: (...args: Parameters<PeopleRepositoryService["getPerson"]>) =>
        publicOperation("people.get-person", people.getPerson(...args)),
      findPersonBySourceIdentity: (...args: Parameters<PeopleRepositoryService["findPersonBySourceIdentity"]>) =>
        publicOperation("people.find-person-by-source-identity", people.findPersonBySourceIdentity(...args)),
      getRoleAssignment: (...args: Parameters<PeopleRepositoryService["getRoleAssignment"]>) =>
        publicOperation("people.get-role", people.getRoleAssignment(...args)),
      listRoleAssignments: (...args: Parameters<PeopleRepositoryService["listRoleAssignments"]>) =>
        publicOperation("people.list-roles", people.listRoleAssignments(...args)),
      updatePerson: (...args: Parameters<PeopleRepositoryService["updatePerson"]>) =>
        publicOperation("people.update-person", people.updatePerson(...args)),
      updateRoleAssignment: (...args: Parameters<PeopleRepositoryService["updateRoleAssignment"]>) =>
        publicOperation("people.update-role", people.updateRoleAssignment(...args))
    },
    pluginConnections: {
      create: (...args: Parameters<PluginConnectionRepositoryService["create"]>) =>
        publicOperation("plugin-connection.create", pluginConnections.create(...args)),
      createBounded: (...args: Parameters<PluginConnectionRepositoryService["createBounded"]>) =>
        publicOperation("plugin-connection.create-bounded", pluginConnections.createBounded(...args)),
      bindResource: (...args: Parameters<PluginConnectionRepositoryService["bindResource"]>) =>
        publicOperation("plugin-connection.bind-resource", pluginConnections.bindResource(...args)),
      get: (...args: Parameters<PluginConnectionRepositoryService["get"]>) =>
        publicOperation("plugin-connection.get", pluginConnections.get(...args)),
      list: (...args: Parameters<PluginConnectionRepositoryService["list"]>) =>
        publicOperation("plugin-connection.list", pluginConnections.list(...args)),
      updateMetadata: (...args: Parameters<PluginConnectionRepositoryService["updateMetadata"]>) =>
        publicOperation("plugin-connection.update", pluginConnections.updateMetadata(...args))
    },
    pluginConfigurations: {
      completeSecretCleanup: (...args: Parameters<PluginConfigurationRepositoryService["completeSecretCleanup"]>) =>
        publicOperation(
          "plugin-configuration.complete-secret-cleanup",
          pluginConfigurations.completeSecretCleanup(...args)
        ),
      get: (...args: Parameters<PluginConfigurationRepositoryService["get"]>) =>
        publicOperation("plugin-configuration.get", pluginConfigurations.get(...args)),
      pendingSecretCleanup: (...args: Parameters<PluginConfigurationRepositoryService["pendingSecretCleanup"]>) =>
        publicOperation(
          "plugin-configuration.pending-secret-cleanup",
          pluginConfigurations.pendingSecretCleanup(...args)
        ),
      requestSecretCleanup: (...args: Parameters<PluginConfigurationRepositoryService["requestSecretCleanup"]>) =>
        publicOperation(
          "plugin-configuration.request-secret-cleanup",
          pluginConfigurations.requestSecretCleanup(...args)
        ),
      update: (...args: Parameters<PluginConfigurationRepositoryService["update"]>) =>
        publicOperation("plugin-configuration.update", pluginConfigurations.update(...args))
    },
    pluginRuntime: {
      acceptPluginDescriptor: (...args: Parameters<PluginRuntimeRepositoryService["acceptPluginDescriptor"]>) =>
        publicOperation("plugin-runtime.accept-plugin-descriptor", pluginRuntime.acceptPluginDescriptor(...args)),
      beginSyncAttempt: (...args: Parameters<PluginRuntimeRepositoryService["beginSyncAttempt"]>) =>
        publicOperation("plugin-runtime.begin-sync-attempt", pluginRuntime.beginSyncAttempt(...args)),
      claimSync: (...args: Parameters<PluginRuntimeRepositoryService["claimSync"]>) =>
        publicOperation("plugin-runtime.claim-sync", pluginRuntime.claimSync(...args)),
      commitNormalizedPage: (...args: Parameters<PluginRuntimeRepositoryService["commitNormalizedPage"]>) =>
        publicOperation("plugin-runtime.commit-normalized-page", pluginRuntime.commitNormalizedPage(...args)),
      commitNormalizedPageReceipt: (
        ...args: Parameters<PluginRuntimeRepositoryService["commitNormalizedPageReceipt"]>
      ) =>
        publicOperation(
          "plugin-runtime.commit-normalized-page-receipt",
          pluginRuntime.commitNormalizedPageReceipt(...args)
        ),
      completeSyncAttempt: (...args: Parameters<PluginRuntimeRepositoryService["completeSyncAttempt"]>) =>
        publicOperation("plugin-runtime.complete-sync-attempt", pluginRuntime.completeSyncAttempt(...args)),
      getCache: (...args: Parameters<PluginRuntimeRepositoryService["getCache"]>) =>
        publicOperation("plugin-runtime.get-cache", pluginRuntime.getCache(...args)),
      getCodePipelineCacheBeforeTombstones: (
        ...args: Parameters<PluginRuntimeRepositoryService["getCodePipelineCacheBeforeTombstones"]>
      ) =>
        publicOperation(
          "plugin-runtime.get-codepipeline-cache-before-tombstones",
          pluginRuntime.getCodePipelineCacheBeforeTombstones(...args)
        ),
      getCodePipelineCache: (...args: Parameters<PluginRuntimeRepositoryService["getCodePipelineCache"]>) =>
        publicOperation("plugin-runtime.get-codepipeline-cache", pluginRuntime.getCodePipelineCache(...args)),
      getLastSuccessfulHealth: (...args: Parameters<PluginRuntimeRepositoryService["getLastSuccessfulHealth"]>) =>
        publicOperation(
          "plugin-runtime.get-last-successful-health",
          pluginRuntime.getLastSuccessfulHealth(...args)
        ),
      getRuntime: (...args: Parameters<PluginRuntimeRepositoryService["getRuntime"]>) =>
        publicOperation("plugin-runtime.get", pluginRuntime.getRuntime(...args)),
      getSyncAttemptState: (...args: Parameters<PluginRuntimeRepositoryService["getSyncAttemptState"]>) =>
        publicOperation("plugin-runtime.get-sync-attempt-state", pluginRuntime.getSyncAttemptState(...args)),
      getStream: (...args: Parameters<PluginRuntimeRepositoryService["getStream"]>) =>
        publicOperation("plugin-runtime.get-stream", pluginRuntime.getStream(...args)),
      listEvidence: (...args: Parameters<PluginRuntimeRepositoryService["listEvidence"]>) =>
        publicOperation("plugin-runtime.list-evidence", pluginRuntime.listEvidence(...args)),
      listSyncAttempts: (...args: Parameters<PluginRuntimeRepositoryService["listSyncAttempts"]>) =>
        publicOperation("plugin-runtime.list-sync-attempts", pluginRuntime.listSyncAttempts(...args)),
      reconcileSyncAttempts: (...args: Parameters<PluginRuntimeRepositoryService["reconcileSyncAttempts"]>) =>
        publicOperation("plugin-runtime.reconcile-sync-attempts", pluginRuntime.reconcileSyncAttempts(...args)),
      releaseSyncClaim: (...args: Parameters<PluginRuntimeRepositoryService["releaseSyncClaim"]>) =>
        publicOperation("plugin-runtime.release-sync-claim", pluginRuntime.releaseSyncClaim(...args)),
      recordHealth: (...args: Parameters<PluginRuntimeRepositoryService["recordHealth"]>) =>
        publicOperation("plugin-runtime.record-health", pluginRuntime.recordHealth(...args))
    },
    providerAccounts: {
      create: (...args: Parameters<ProviderAccountRepositoryService["create"]>) =>
        publicOperation("provider-account.create", providerAccounts.create(...args)),
      followResource: (...args: Parameters<ProviderAccountRepositoryService["followResource"]>) =>
        publicOperation("provider-account.follow-resource", providerAccounts.followResource(...args)),
      get: (...args: Parameters<ProviderAccountRepositoryService["get"]>) =>
        publicOperation("provider-account.get", providerAccounts.get(...args)),
      getResource: (...args: Parameters<ProviderAccountRepositoryService["getResource"]>) =>
        publicOperation("provider-account.get-resource", providerAccounts.getResource(...args)),
      list: (...args: Parameters<ProviderAccountRepositoryService["list"]>) =>
        publicOperation("provider-account.list", providerAccounts.list(...args)),
      listResources: (...args: Parameters<ProviderAccountRepositoryService["listResources"]>) =>
        publicOperation("provider-account.list-resources", providerAccounts.listResources(...args)),
      updateMetadata: (...args: Parameters<ProviderAccountRepositoryService["updateMetadata"]>) =>
        publicOperation("provider-account.update", providerAccounts.updateMetadata(...args)),
      updateResourceMetadata: (...args: Parameters<ProviderAccountRepositoryService["updateResourceMetadata"]>) =>
        publicOperation("provider-account.update-resource", providerAccounts.updateResourceMetadata(...args))
    },
    readiness: {
      claimInvalidation: (...args: Parameters<ReadinessRepositoryService["claimInvalidation"]>) =>
        publicOperation("readiness.claim-invalidation", readiness.claimInvalidation(...args)),
      commitEnvironment: (...args: Parameters<ReadinessRepositoryService["commitEnvironment"]>) =>
        publicOperation("readiness.commit-environment", readiness.commitEnvironment(...args)),
      commitRelease: (...args: Parameters<ReadinessRepositoryService["commitRelease"]>) =>
        publicOperation("readiness.commit-release", readiness.commitRelease(...args)),
      enqueueAffected: (...args: Parameters<ReadinessRepositoryService["enqueueAffected"]>) =>
        publicOperation("readiness.enqueue-affected", readiness.enqueueAffected(...args)),
      enqueueDue: (...args: Parameters<ReadinessRepositoryService["enqueueDue"]>) =>
        publicOperation("readiness.enqueue-due", readiness.enqueueDue(...args)),
      enqueueInvalidation: (...args: Parameters<ReadinessRepositoryService["enqueueInvalidation"]>) =>
        publicOperation("readiness.enqueue-invalidation", readiness.enqueueInvalidation(...args)),
      readCurrent: (...args: Parameters<ReadinessRepositoryService["readCurrent"]>) =>
        publicOperation("readiness.read-current", readiness.readCurrent(...args)).pipe(
          Effect.provideService(Crypto.Crypto, cryptoService)
        ),
      readCurrentReleases: (...args: Parameters<ReadinessRepositoryService["readCurrentReleases"]>) =>
        publicOperation("readiness.read-current-releases", readiness.readCurrentReleases(...args)).pipe(
          Effect.provideService(Crypto.Crypto, cryptoService)
        ),
      readHistory: (...args: Parameters<ReadinessRepositoryService["readHistory"]>) =>
        publicOperation("readiness.read-history", readiness.readHistory(...args)),
      registerRule: (...args: Parameters<ReadinessRepositoryService["registerRule"]>) =>
        publicOperation("readiness.register-rule", readiness.registerRule(...args))
    },
    relationshipRepairProposals: {
      application: (...args: Parameters<RelationshipRepairProposalRepositoryService["application"]>) =>
        publicOperation("relationship-repair-proposal.application", relationshipRepairProposals.application(...args)),
      create: (...args: Parameters<RelationshipRepairProposalRepositoryService["create"]>) =>
        publicOperation("relationship-repair-proposal.create", relationshipRepairProposals.create(...args)),
      get: (...args: Parameters<RelationshipRepairProposalRepositoryService["get"]>) =>
        publicOperation("relationship-repair-proposal.get", relationshipRepairProposals.get(...args)),
      list: (...args: Parameters<RelationshipRepairProposalRepositoryService["list"]>) =>
        publicOperation("relationship-repair-proposal.list", relationshipRepairProposals.list(...args)),
      listApplications: (...args: Parameters<RelationshipRepairProposalRepositoryService["listApplications"]>) =>
        publicOperation(
          "relationship-repair-proposal.list-applications",
          relationshipRepairProposals.listApplications(...args)
        ),
      review: (...args: Parameters<RelationshipRepairProposalRepositoryService["review"]>) =>
        publicOperation("relationship-repair-proposal.review", relationshipRepairProposals.review(...args)),
      recordApplication: (...args: Parameters<RelationshipRepairProposalRepositoryService["recordApplication"]>) =>
        publicOperation(
          "relationship-repair-proposal.record-application",
          relationshipRepairProposals.recordApplication(...args)
        )
    },
    releases: {
      append: (...args: Parameters<ReleaseRepositoryService["append"]>) =>
        publicOperation("release.append", releases.append(...args)),
      create: (...args: Parameters<ReleaseRepositoryService["create"]>) =>
        publicOperation("release.create", releases.create(...args)),
      get: (...args: Parameters<ReleaseRepositoryService["get"]>) =>
        publicOperation("release.get", releases.get(...args)),
      list: (...args: Parameters<ReleaseRepositoryService["list"]>) =>
        publicOperation("release.list", releases.list(...args))
    },
    retention: {
      listRuns: (...args: Parameters<RetentionRepositoryService["listRuns"]>) =>
        publicOperation("retention.list-runs", retention.listRuns(...args)),
      recordSandboxReconciliation: (
        ...args: Parameters<
          RetentionRepositoryService["recordSandboxReconciliation"]
        >
      ) =>
        publicOperation(
          "retention.record-sandbox-reconciliation",
          retention.recordSandboxReconciliation(...args)
        ),
      sweepWorkspace: (...args: Parameters<RetentionRepositoryService["sweepWorkspace"]>) =>
        publicOperation(
          "retention.sweep-workspace",
          retention.sweepWorkspace(...args).pipe(
            Effect.tap(() =>
              completeDeferredCleanupBestEffort(
                sweepDiffContentCacheCleanup(database, content, diffContentCache)
              )
            )
          )
        )
    },
    timeline: {
      detail: (...args: Parameters<TimelineRepositoryService["detail"]>) =>
        publicOperation("timeline.detail", timeline.detail(...args)),
      page: (...args: Parameters<TimelineRepositoryService["page"]>) =>
        publicOperation("timeline.page", timeline.page(...args))
    },
    timelineExportAudits: {
      record: (...args: Parameters<TimelineExportAuditRepositoryService["record"]>) =>
        publicOperation("timeline-export-audit.record", timelineExportAudits.record(...args))
    },
    workspaces: {
      create: (...args: Parameters<WorkspaceRepositoryService["create"]>) =>
        publicOperation("workspace.create", workspaces.create(...args)),
      get: (...args: Parameters<WorkspaceRepositoryService["get"]>) =>
        publicOperation("workspace.get", workspaces.get(...args)),
      updateDisplayName: (...args: Parameters<WorkspaceRepositoryService["updateDisplayName"]>) =>
        publicOperation("workspace.update", workspaces.updateDisplayName(...args))
    },
    workspaceSettings: {
      audits: (...args: Parameters<WorkspaceSettingsRepositoryService["audits"]>) =>
        publicOperation("workspace-settings.audits", workspaceSettings.audits(...args)),
      get: (...args: Parameters<WorkspaceSettingsRepositoryService["get"]>) =>
        publicOperation("workspace-settings.get", workspaceSettings.get(...args)),
      readAtomically: workspaceSettings.readAtomically,
      update: (...args: Parameters<WorkspaceSettingsRepositoryService["update"]>) =>
        publicOperation("workspace-settings.update", workspaceSettings.update(...args)),
      updateAtomically: (...args: Parameters<WorkspaceSettingsRepositoryService["updateAtomically"]>) =>
        publicOperation("workspace-settings.update-atomically", workspaceSettings.updateAtomically(...args))
    }
  }
})

/** Public repository collection exposed to authenticated server workflows. */
export interface PersistenceService extends Omit<Success<typeof makePersistence>, "agentJobs"> {
  readonly agentJobs:
    & Omit<Success<typeof makePersistence>["agentJobs"], "attachRunningPrReviewSession" | "interruptRunningReviews">
    & {
      readonly attachRunningPrReviewSession?: Success<
        typeof makePersistence
      >["agentJobs"]["attachRunningPrReviewSession"]
      readonly interruptRunningReviews?: Success<typeof makePersistence>["agentJobs"]["interruptRunningReviews"]
    }
}

/** Server-only durable state boundary; the database and filesystem stay private. */
export class Persistence extends Context.Service<Persistence, PersistenceService>()(
  "@knpkv/control-center/Persistence"
) {}

const PersistenceFromServices = Layer.effect(Persistence, makePersistence)

/** Build persistence repositories from a caller-owned shared database service. */
export const persistenceLayerFromDatabase = (
  input: unknown
): Layer.Layer<
  Persistence,
  BlobStoreError | PersistenceConfigError,
  Crypto.Crypto | Database | FileSystem.FileSystem | Path.Path
> =>
  Layer.unwrap(
    decodePersistenceConfig(input).pipe(
      Effect.map((config) => {
        const foundation = QuarantineRepository.layer
        const agentJobs = AgentJobRepository.layer
        const authorizedShares = AuthorizedShareRepository.layer
        const contentMetadata = ContentBlobMetadataRepository.layer.pipe(
          Layer.provide(foundation)
        )
        const entities = EntityRepository.layer.pipe(Layer.provide(foundation))
        const deliveryGraph = DeliveryGraphRepository.layer.pipe(Layer.provide(foundation))
        const events = DomainEventRepository.layer.pipe(Layer.provide(foundation))
        const governedActions = GovernedActionRepository.layer.pipe(Layer.provide(foundation))
        const people = PeopleRepository.layer.pipe(Layer.provide(foundation))
        const pluginConnections = PluginConnectionRepository.layer.pipe(Layer.provide(foundation))
        const pluginConfigurations = PluginConfigurationRepository.layer.pipe(Layer.provide(foundation))
        const pluginRuntime = PluginRuntimeRepository.layer.pipe(Layer.provide(foundation))
        const providerAccounts = ProviderAccountRepository.layer.pipe(Layer.provide(foundation))
        const readiness = ReadinessRepository.layer.pipe(Layer.provide(foundation))
        const relationshipRepairProposals = RelationshipRepairProposalRepository.layer
        const release = ReleaseRepository.layer.pipe(Layer.provide(foundation))
        const timeline = TimelineRepository.layer
        const timelineExportAudits = TimelineExportAuditRepository.layer
        const workspaces = WorkspaceRepository.layer.pipe(Layer.provide(foundation))
        const workspaceSettings = WorkspaceSettingsRepository.layer.pipe(Layer.provide(foundation))
        const retention = RetentionRepository.layer.pipe(Layer.provide(workspaceSettings))
        const blobs = BlobStore.layer({ blobRoot: config.blobRoot })
        const diffContentCache = DiffContentCacheRepository.layer
        const content = ContentStore.layer.pipe(
          Layer.provide(Layer.merge(contentMetadata, blobs))
        )
        const services = Layer.mergeAll(
          foundation,
          agentJobs,
          authorizedShares,
          contentMetadata,
          deliveryGraph,
          diffContentCache,
          entities,
          events,
          governedActions,
          people,
          pluginConnections,
          pluginConfigurations,
          pluginRuntime,
          providerAccounts,
          readiness,
          relationshipRepairProposals,
          release,
          retention,
          timeline,
          timelineExportAudits,
          content,
          workspaces,
          workspaceSettings
        )
        return PersistenceFromServices.pipe(Layer.provide(services))
      })
    )
  )

/** Build one shared libSQL client and owner-only blob service from decoded input. */
export const persistenceLayer = (
  input: unknown
): Layer.Layer<
  Persistence,
  PersistenceLayerError,
  Crypto.Crypto | FileSystem.FileSystem | Path.Path
> => persistenceLayerFromDatabase(input).pipe(Layer.provide(databaseLayer(input)))
