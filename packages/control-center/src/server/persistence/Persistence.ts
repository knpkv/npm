import type { Crypto, FileSystem, Path } from "effect"
import { Context, Effect, Layer, Predicate } from "effect"
import type { Success } from "effect/Effect"

import type { BackupFailure, MigrationWriteBarrierError } from "./backup/index.js"
import { ContentStore, type ContentStoreService } from "./ContentStore.js"
import { Database, databaseLayer } from "./Database.js"
import {
  type ContentMetadataMismatchError,
  type DatabaseInitializationError,
  type MigrationLedgerError,
  type PersistedRecordError,
  type PersistenceConfigError,
  PersistenceOperationError,
  type QuarantineWriteError,
  type RecordAlreadyExistsError,
  type RecordNotFoundError,
  type ReproducibleContentUnavailableError,
  type RevisionConflictError,
  type SecretReferenceScopeConflictError,
  type SourceIdentityMismatchError
} from "./errors.js"
import { BlobStore } from "./object-store/BlobStore.js"
import type { BlobStoreError } from "./object-store/BlobStoreError.js"
import { decodePersistenceConfig } from "./PersistenceConfig.js"
import {
  ContentBlobMetadataRepository,
  DomainEventRepository,
  type DomainEventRepositoryService,
  EntityRepository,
  type EntityRepositoryService,
  PeopleRepository,
  type PeopleRepositoryService,
  PluginConfigurationRepository,
  type PluginConfigurationRepositoryService,
  PluginConnectionRepository,
  type PluginConnectionRepositoryService,
  PluginRuntimeRepository,
  type PluginRuntimeRepositoryService,
  QuarantineRepository,
  ReleaseRepository,
  type ReleaseRepositoryService,
  WorkspaceRepository,
  type WorkspaceRepositoryService
} from "./repositories/index.js"
import { mapPersistenceOperation } from "./repositories/internal.js"

/** Typed failures that may cross the public persistence operation boundary. */
export type PersistenceOperationFailure =
  | BlobStoreError
  | ContentMetadataMismatchError
  | PersistedRecordError
  | PersistenceOperationError
  | QuarantineWriteError
  | RecordAlreadyExistsError
  | RecordNotFoundError
  | ReproducibleContentUnavailableError
  | RevisionConflictError
  | SecretReferenceScopeConflictError
  | SourceIdentityMismatchError

const PUBLIC_OPERATION_ERROR_TAGS = new Set([
  "BlobContainmentError",
  "BlobIntegrityError",
  "BlobNotFoundError",
  "BlobStoreInputError",
  "BlobStoreIoError",
  "BlobTooLargeError",
  "BlobUnexpectedEofError",
  "ContentMetadataMismatchError",
  "PersistedRecordError",
  "PersistenceOperationError",
  "QuarantineWriteError",
  "RecordAlreadyExistsError",
  "RecordNotFoundError",
  "ReproducibleContentUnavailableError",
  "RevisionConflictError",
  "SecretReferenceScopeConflictError",
  "SourceIdentityMismatchError"
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

/** Failures possible while acquiring the durable persistence service. */
export type PersistenceLayerError =
  | BackupFailure
  | BlobStoreError
  | DatabaseInitializationError
  | MigrationLedgerError
  | MigrationWriteBarrierError
  | PersistenceConfigError

const makePersistence = Effect.gen(function*() {
  const database = yield* Database
  const content = yield* ContentStore
  const events = yield* DomainEventRepository
  const entities = yield* EntityRepository
  const people = yield* PeopleRepository
  const pluginConnections = yield* PluginConnectionRepository
  const pluginConfigurations = yield* PluginConfigurationRepository
  const pluginRuntime = yield* PluginRuntimeRepository
  const releases = yield* ReleaseRepository
  const workspaces = yield* WorkspaceRepository

  return {
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
    entities: {
      create: (...args: Parameters<EntityRepositoryService["create"]>) =>
        publicOperation("entity.create", entities.create(...args)),
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
      get: (...args: Parameters<PluginConnectionRepositoryService["get"]>) =>
        publicOperation("plugin-connection.get", pluginConnections.get(...args)),
      list: (...args: Parameters<PluginConnectionRepositoryService["list"]>) =>
        publicOperation("plugin-connection.list", pluginConnections.list(...args)),
      updateMetadata: (...args: Parameters<PluginConnectionRepositoryService["updateMetadata"]>) =>
        publicOperation("plugin-connection.update", pluginConnections.updateMetadata(...args))
    },
    pluginConfigurations: {
      get: (...args: Parameters<PluginConfigurationRepositoryService["get"]>) =>
        publicOperation("plugin-configuration.get", pluginConfigurations.get(...args)),
      update: (...args: Parameters<PluginConfigurationRepositoryService["update"]>) =>
        publicOperation("plugin-configuration.update", pluginConfigurations.update(...args))
    },
    pluginRuntime: {
      acceptPluginDescriptor: (...args: Parameters<PluginRuntimeRepositoryService["acceptPluginDescriptor"]>) =>
        publicOperation("plugin-runtime.accept-plugin-descriptor", pluginRuntime.acceptPluginDescriptor(...args)),
      commitNormalizedPage: (...args: Parameters<PluginRuntimeRepositoryService["commitNormalizedPage"]>) =>
        publicOperation("plugin-runtime.commit-normalized-page", pluginRuntime.commitNormalizedPage(...args)),
      getCache: (...args: Parameters<PluginRuntimeRepositoryService["getCache"]>) =>
        publicOperation("plugin-runtime.get-cache", pluginRuntime.getCache(...args)),
      getLastSuccessfulHealth: (...args: Parameters<PluginRuntimeRepositoryService["getLastSuccessfulHealth"]>) =>
        publicOperation(
          "plugin-runtime.get-last-successful-health",
          pluginRuntime.getLastSuccessfulHealth(...args)
        ),
      getRuntime: (...args: Parameters<PluginRuntimeRepositoryService["getRuntime"]>) =>
        publicOperation("plugin-runtime.get", pluginRuntime.getRuntime(...args)),
      getStream: (...args: Parameters<PluginRuntimeRepositoryService["getStream"]>) =>
        publicOperation("plugin-runtime.get-stream", pluginRuntime.getStream(...args)),
      listEvidence: (...args: Parameters<PluginRuntimeRepositoryService["listEvidence"]>) =>
        publicOperation("plugin-runtime.list-evidence", pluginRuntime.listEvidence(...args)),
      recordHealth: (...args: Parameters<PluginRuntimeRepositoryService["recordHealth"]>) =>
        publicOperation("plugin-runtime.record-health", pluginRuntime.recordHealth(...args))
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
    workspaces: {
      create: (...args: Parameters<WorkspaceRepositoryService["create"]>) =>
        publicOperation("workspace.create", workspaces.create(...args)),
      get: (...args: Parameters<WorkspaceRepositoryService["get"]>) =>
        publicOperation("workspace.get", workspaces.get(...args)),
      updateDisplayName: (...args: Parameters<WorkspaceRepositoryService["updateDisplayName"]>) =>
        publicOperation("workspace.update", workspaces.updateDisplayName(...args))
    }
  }
})

/** Public repository collection exposed to authenticated server workflows. */
export interface PersistenceService extends Success<typeof makePersistence> {}

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
        const contentMetadata = ContentBlobMetadataRepository.layer.pipe(
          Layer.provide(foundation)
        )
        const entities = EntityRepository.layer.pipe(Layer.provide(foundation))
        const events = DomainEventRepository.layer.pipe(Layer.provide(foundation))
        const people = PeopleRepository.layer.pipe(Layer.provide(foundation))
        const pluginConnections = PluginConnectionRepository.layer.pipe(Layer.provide(foundation))
        const pluginConfigurations = PluginConfigurationRepository.layer.pipe(Layer.provide(foundation))
        const pluginRuntime = PluginRuntimeRepository.layer.pipe(Layer.provide(foundation))
        const release = ReleaseRepository.layer.pipe(Layer.provide(foundation))
        const workspaces = WorkspaceRepository.layer.pipe(Layer.provide(foundation))
        const blobs = BlobStore.layer({ blobRoot: config.blobRoot })
        const content = ContentStore.layer.pipe(
          Layer.provide(Layer.merge(contentMetadata, blobs))
        )
        const services = Layer.mergeAll(
          foundation,
          contentMetadata,
          entities,
          events,
          people,
          pluginConnections,
          pluginConfigurations,
          pluginRuntime,
          release,
          content,
          workspaces
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
