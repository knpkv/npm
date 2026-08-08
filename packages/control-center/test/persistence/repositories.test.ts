import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert, describe, it } from "@effect/vitest"
import type { Crypto, Path, Scope } from "effect"
import { Context, Deferred, Effect, Fiber, FileSystem, Layer, Option, Ref, Result, Schema } from "effect"

import { DiffFileAnchor } from "../../src/api/diff.js"
import { Person, RoleAssignment } from "../../src/domain/actors.js"
import { AgentId, EntityId, PluginConnectionId, RoleAssignmentId, WorkspaceId } from "../../src/domain/identifiers.js"
import { Revision, SourceRevision, VendorImmutableId } from "../../src/domain/sourceRevision.js"
import { UtcTimestamp } from "../../src/domain/utcTimestamp.js"
import { ContentStore } from "../../src/server/persistence/ContentStore.js"
import { Database, databaseLayer } from "../../src/server/persistence/Database.js"
import {
  ContentMetadataMismatchError,
  PersistedRecordError,
  RecordNotFoundError,
  RevisionConflictError,
  SourceIdentityMismatchError
} from "../../src/server/persistence/errors.js"
import { BlobDigest } from "../../src/server/persistence/object-store/BlobDigest.js"
import { BlobStore } from "../../src/server/persistence/object-store/BlobStore.js"
import { BlobStoreIoError } from "../../src/server/persistence/object-store/BlobStoreError.js"
import {
  putAndSweepDiffContentCache,
  putContentAndSweepDiffContentCache,
  sweepDiffContentCacheCleanup
} from "../../src/server/persistence/Persistence.js"
import { BlobRoot } from "../../src/server/persistence/PersistenceConfig.js"
import { ContentBlobMetadataRepository } from "../../src/server/persistence/repositories/contentBlobMetadataRepository.js"
import {
  type DiffContentCacheKey,
  DiffContentCacheRepository,
  MaximumDiffContentCacheCleanupBatch
} from "../../src/server/persistence/repositories/diffContentCacheRepository.js"
import { EntityRepository } from "../../src/server/persistence/repositories/entityRepository.js"
import {
  ContentBlobDigest,
  PluginConnectionDisplayName,
  RecordRevision,
  WorkspaceName
} from "../../src/server/persistence/repositories/models.js"
import { PeopleRepository } from "../../src/server/persistence/repositories/peopleRepository.js"
import { PluginConnectionRepository } from "../../src/server/persistence/repositories/pluginConnectionRepository.js"
import { QuarantineRepository } from "../../src/server/persistence/repositories/quarantineRepository.js"
import { WorkspaceRepository } from "../../src/server/persistence/repositories/workspaceRepository.js"
import { descriptorIt } from "../fixtures/descriptorPublication.js"

const WORKSPACE_A = Schema.decodeSync(WorkspaceId)("01890f6f-6d6a-7cc0-98d2-000000000001")
const WORKSPACE_B = Schema.decodeSync(WorkspaceId)("01890f6f-6d6a-7cc0-98d2-000000000002")
const PLUGIN_ID = Schema.decodeSync(PluginConnectionId)("01890f6f-6d6a-7cc0-98d2-000000000003")
const SECOND_PLUGIN_ID = Schema.decodeSync(PluginConnectionId)("01890f6f-6d6a-7cc0-98d2-000000000008")
const ENTITY_ID = Schema.decodeSync(EntityId)("01890f6f-6d6a-7cc0-98d2-000000000004")
const AGENT_ID = Schema.decodeSync(AgentId)("01890f6f-6d6a-7cc0-98d2-000000000006")
const ASSIGNMENT_ID = Schema.decodeSync(RoleAssignmentId)("01890f6f-6d6a-7cc0-98d2-000000000007")
const SECOND_ASSIGNMENT_ID = Schema.decodeSync(RoleAssignmentId)("01890f6f-6d6a-7cc0-98d2-00000000000a")
const CREATED_AT = Schema.decodeSync(UtcTimestamp)("2026-07-13T10:00:00.000Z")
const UPDATED_AT = Schema.decodeSync(UtcTimestamp)("2026-07-13T10:05:00.000Z")
const CONTENT_DIGEST = Schema.decodeSync(BlobDigest)("b".repeat(64))
const SECOND_CONTENT_DIGEST = Schema.decodeSync(BlobDigest)("c".repeat(64))
const PAYMENTS = WorkspaceName.make("Payments")
const IDENTITY = WorkspaceName.make("Identity")
const ExplainQueryPlanRow = Schema.Struct({ detail: Schema.String })

const person = Schema.decodeSync(Person)({
  personId: "01890f6f-6d6a-7cc0-98d2-000000000005",
  displayName: "Maya Chen",
  avatar: { _tag: "initials", text: "MC" },
  isActive: true,
  sourceIdentities: [
    {
      pluginConnectionId: PLUGIN_ID,
      providerId: "jira",
      vendorPersonId: "account-maya"
    }
  ]
})

const sourceRevision = Schema.decodeSync(SourceRevision)({
  pluginConnectionId: PLUGIN_ID,
  providerId: "jira",
  vendorImmutableId: "PAY-42",
  revision: "1001",
  normalizationSchemaVersion: 1,
  sourceUrl: "https://jira.example/browse/PAY-42",
  firstObservedAt: "2026-07-13T10:00:00.000Z",
  lastObservedAt: "2026-07-13T10:01:00.000Z",
  synchronizedAt: "2026-07-13T10:02:00.000Z"
})

const testConfig = Effect.gen(function*() {
  const fileSystem = yield* FileSystem.FileSystem
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "control-center-repositories-" })
  return {
    blobRoot: BlobRoot.make(`${root}/blobs`),
    busyTimeoutMilliseconds: 5_000,
    databaseUrl: `file:${root}/control-center.db`,
    maxConnections: 1
  }
})

interface RepositoryTestConfigShape {
  readonly blobRoot: BlobRoot
  readonly busyTimeoutMilliseconds: number
  readonly databaseUrl: string
  readonly maxConnections: number
}

class RepositoryTestConfig extends Context.Service<RepositoryTestConfig, RepositoryTestConfigShape>()(
  "@knpkv/control-center/test/RepositoryTestConfig"
) {}

const withRepositories = <Success, Failure>(
  use: Effect.Effect<
    Success,
    Failure,
    | ContentStore
    | Crypto.Crypto
    | EntityRepository
    | FileSystem.FileSystem
    | ContentBlobMetadataRepository
    | Database
    | DiffContentCacheRepository
    | BlobStore
    | PeopleRepository
    | Path.Path
    | PluginConnectionRepository
    | QuarantineRepository
    | RepositoryTestConfig
    | Scope.Scope
    | WorkspaceRepository
  >
) =>
  Effect.gen(function*() {
    const config = yield* testConfig
    const database = databaseLayer(config)
    const blobs = BlobStore.layer({ blobRoot: config.blobRoot })
    const foundation = QuarantineRepository.layer.pipe(Layer.provideMerge(database))
    const content = ContentBlobMetadataRepository.layer.pipe(Layer.provide(foundation))
    const contentStore = ContentStore.layer.pipe(Layer.provide(Layer.mergeAll(content, blobs, database)))
    const entities = EntityRepository.layer.pipe(Layer.provide(foundation))
    const diffContentCache = DiffContentCacheRepository.layer.pipe(Layer.provide(database))
    const people = PeopleRepository.layer.pipe(Layer.provide(foundation))
    const plugins = PluginConnectionRepository.layer.pipe(Layer.provide(foundation))
    const workspaces = WorkspaceRepository.layer.pipe(Layer.provide(foundation))
    const repositories = Layer.mergeAll(
      Layer.succeed(RepositoryTestConfig, config),
      foundation,
      blobs,
      content,
      contentStore,
      diffContentCache,
      entities,
      people,
      plugins,
      workspaces
    )
    return yield* use.pipe(Effect.provide(repositories))
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped)

const createWorkspaceAndPlugin = Effect.gen(function*() {
  const workspaces = yield* WorkspaceRepository
  const plugins = yield* PluginConnectionRepository
  yield* workspaces.create(WORKSPACE_A, { displayName: PAYMENTS, createdAt: CREATED_AT })
  yield* plugins.create(WORKSPACE_A, {
    pluginConnectionId: PLUGIN_ID,
    providerId: "jira",
    displayName: PluginConnectionDisplayName.make("Payments Jira"),
    isEnabled: true,
    createdAt: CREATED_AT
  })
})

describe("workspace-scoped repositories", () => {
  it.effect("isolates records by workspace and distinguishes missing from stale CAS", () =>
    withRepositories(
      Effect.gen(function*() {
        const workspaces = yield* WorkspaceRepository
        const content = yield* ContentBlobMetadataRepository
        yield* workspaces.create(WORKSPACE_A, { displayName: PAYMENTS, createdAt: CREATED_AT })
        yield* workspaces.create(WORKSPACE_B, { displayName: IDENTITY, createdAt: CREATED_AT })

        const metadata = yield* content.create(WORKSPACE_A, {
          digest: CONTENT_DIGEST,
          storageClass: "durable",
          byteLength: 42,
          mimeType: "application/json",
          createdAt: CREATED_AT,
          lastVerifiedAt: null
        })
        assert.strictEqual(metadata.digest, CONTENT_DIGEST)
        const crossWorkspaceBlob = yield* content.get(WORKSPACE_B, CONTENT_DIGEST).pipe(Effect.result)
        assert.isTrue(Result.isFailure(crossWorkspaceBlob))
        if (Result.isFailure(crossWorkspaceBlob)) {
          assert.instanceOf(crossWorkspaceBlob.failure, RecordNotFoundError)
        }

        const missing = yield* workspaces
          .get(Schema.decodeSync(WorkspaceId)("01890f6f-6d6a-7cc0-98d2-000000000009"))
          .pipe(Effect.result)
        assert.isTrue(Result.isFailure(missing))
        if (Result.isFailure(missing)) assert.instanceOf(missing.failure, RecordNotFoundError)

        const updated = yield* workspaces.updateDisplayName(WORKSPACE_A, {
          displayName: WorkspaceName.make("Payments Platform"),
          expectedRevision: RecordRevision.make(1),
          updatedAt: UPDATED_AT
        })
        assert.strictEqual(updated.revision, 2)
        assert.strictEqual((yield* workspaces.get(WORKSPACE_B)).displayName, "Identity")

        const stale = yield* workspaces
          .updateDisplayName(WORKSPACE_A, {
            displayName: WorkspaceName.make("Stale write"),
            expectedRevision: RecordRevision.make(1),
            updatedAt: UPDATED_AT
          })
          .pipe(Effect.result)
        assert.isTrue(Result.isFailure(stale))
        if (Result.isFailure(stale)) {
          assert.instanceOf(stale.failure, RevisionConflictError)
          assert.strictEqual(stale.failure.actualRevision, 2)
        }
      })
    ))

  it.effect("round-trips people and rejects entity source identity replacement", () =>
    withRepositories(
      Effect.gen(function*() {
        yield* createWorkspaceAndPlugin
        const people = yield* PeopleRepository
        const entities = yield* EntityRepository

        const createdPerson = yield* people.createPerson(WORKSPACE_A, person, CREATED_AT)
        assert.strictEqual(createdPerson.person.displayName, "Maya Chen")
        assert.deepStrictEqual(createdPerson.person.sourceIdentities, person.sourceIdentities)

        const assignment = Schema.decodeSync(RoleAssignment)({
          assignmentId: ASSIGNMENT_ID,
          actor: { _tag: "agent", agentId: AGENT_ID },
          role: "workspace-approver",
          scope: { _tag: "workspace", workspaceId: WORKSPACE_A },
          lifecycle: { _tag: "active", assignedAt: "2026-07-13T10:00:00.000Z" }
        })
        const createdAssignment = yield* people.createRoleAssignment(WORKSPACE_A, assignment, CREATED_AT)
        assert.strictEqual(createdAssignment.revision, 1)
        const updatedAssignment = yield* people.updateRoleAssignment(
          WORKSPACE_A,
          Schema.decodeSync(RoleAssignment)({
            ...Schema.encodeSync(RoleAssignment)(assignment),
            role: "workspace-owner"
          }),
          RecordRevision.make(1),
          UPDATED_AT
        )
        assert.strictEqual(updatedAssignment.revision, 2)
        assert.strictEqual(updatedAssignment.assignment.role, "workspace-owner")

        const entity = yield* entities.create(WORKSPACE_A, {
          entityId: ENTITY_ID,
          entityType: "issue",
          sourceRevision,
          createdAt: CREATED_AT
        })
        assert.strictEqual(entity.revision, 1)

        const mismatched = yield* entities
          .updateSourceRevision(WORKSPACE_A, ENTITY_ID, {
            sourceRevision: Schema.decodeSync(SourceRevision)({
              ...Schema.encodeSync(SourceRevision)(sourceRevision),
              vendorImmutableId: "PAY-99"
            }),
            expectedRevision: RecordRevision.make(1),
            updatedAt: UPDATED_AT
          })
          .pipe(Effect.result)
        assert.isTrue(Result.isFailure(mismatched))
        if (Result.isFailure(mismatched)) {
          assert.instanceOf(mismatched.failure, SourceIdentityMismatchError)
        }
        assert.strictEqual((yield* entities.get(WORKSPACE_A, ENTITY_ID)).sourceRevision.vendorImmutableId, "PAY-42")
      })
    ))

  it.effect("quarantines malformed workspace and plugin rows while preserving valid plugins", () =>
    withRepositories(
      Effect.gen(function*() {
        const database = yield* Database
        const plugins = yield* PluginConnectionRepository
        const quarantine = yield* QuarantineRepository
        const workspaces = yield* WorkspaceRepository
        yield* workspaces.create(WORKSPACE_A, { displayName: PAYMENTS, createdAt: CREATED_AT })
        yield* workspaces.create(WORKSPACE_B, { displayName: IDENTITY, createdAt: CREATED_AT })
        yield* plugins.create(WORKSPACE_A, {
          pluginConnectionId: PLUGIN_ID,
          providerId: "jira",
          displayName: PluginConnectionDisplayName.make("Payments Jira"),
          isEnabled: true,
          createdAt: CREATED_AT
        })
        const validPlugin = yield* plugins.create(WORKSPACE_A, {
          pluginConnectionId: SECOND_PLUGIN_ID,
          providerId: "confluence",
          displayName: PluginConnectionDisplayName.make("Payments Confluence"),
          isEnabled: true,
          createdAt: CREATED_AT
        })

        const workspaceCanary = "never-return-malformed-workspace"
        const pluginCanary = "never-return-malformed-plugin"
        yield* database.sql`UPDATE workspaces
          SET updated_at = ${workspaceCanary}
          WHERE workspace_id = ${WORKSPACE_B}`
        yield* database.sql`UPDATE plugin_connections
          SET updated_at = ${pluginCanary}
          WHERE workspace_id = ${WORKSPACE_A}
            AND plugin_connection_id = ${PLUGIN_ID}`

        const malformedWorkspace = yield* workspaces.get(WORKSPACE_B).pipe(Effect.result)
        const malformedPlugin = yield* plugins.get(WORKSPACE_A, PLUGIN_ID).pipe(Effect.result)
        const listed = yield* plugins.list(WORKSPACE_A)
        const records = yield* quarantine.list(WORKSPACE_A)
        const workspaceRecords = yield* quarantine.list(WORKSPACE_B)

        assert.isTrue(Result.isFailure(malformedWorkspace))
        if (Result.isFailure(malformedWorkspace)) {
          assert.instanceOf(malformedWorkspace.failure, PersistedRecordError)
        }
        assert.isTrue(Result.isFailure(malformedPlugin))
        if (Result.isFailure(malformedPlugin)) {
          assert.instanceOf(malformedPlugin.failure, PersistedRecordError)
        }
        assert.deepStrictEqual(listed, [validPlugin])
        assert.strictEqual(records[0]?.recordKind, "plugin-connection")
        assert.strictEqual(records[0]?.diagnosticCode, "plugin-connection-schema-invalid")
        assert.strictEqual(workspaceRecords[0]?.recordKind, "workspace")
        assert.strictEqual(workspaceRecords[0]?.diagnosticCode, "workspace-schema-invalid")
        assert.notInclude(
          JSON.stringify({ listed, malformedPlugin, malformedWorkspace, records, workspaceRecords }),
          workspaceCanary
        )
        assert.notInclude(JSON.stringify(records), pluginCanary)
      })
    ))

  it.effect("isolates malformed person identities from the valid person record", () =>
    withRepositories(
      Effect.gen(function*() {
        yield* createWorkspaceAndPlugin
        const database = yield* Database
        const people = yield* PeopleRepository
        const quarantine = yield* QuarantineRepository
        yield* people.createPerson(WORKSPACE_A, person, CREATED_AT)

        const identityCanary = `never-return-malformed-identity-${"x".repeat(512)}`
        yield* database.sql`PRAGMA ignore_check_constraints = ON`
        yield* database.sql`UPDATE person_identities
          SET vendor_person_id = ${identityCanary}
          WHERE workspace_id = ${WORKSPACE_A}
            AND person_id = ${person.personId}`
        yield* database.sql`PRAGMA ignore_check_constraints = OFF`

        const recovered = yield* people.getPerson(WORKSPACE_A, person.personId)
        const records = yield* quarantine.list(WORKSPACE_A)

        assert.deepStrictEqual(recovered.person.sourceIdentities, [])
        assert.lengthOf(records, 1)
        assert.strictEqual(records[0]?.recordKind, "person-identity")
        assert.strictEqual(records[0]?.diagnosticCode, "person-identity-schema-invalid")
        assert.notInclude(JSON.stringify({ recovered, records }), identityCanary)
      })
    ))

  it.effect("isolates malformed role assignments from workspace role lists", () =>
    withRepositories(
      Effect.gen(function*() {
        const database = yield* Database
        const people = yield* PeopleRepository
        const quarantine = yield* QuarantineRepository
        const workspaces = yield* WorkspaceRepository
        yield* workspaces.create(WORKSPACE_A, { displayName: PAYMENTS, createdAt: CREATED_AT })
        const makeAssignment = (assignmentId: RoleAssignmentId) =>
          Schema.decodeSync(RoleAssignment)({
            assignmentId,
            actor: { _tag: "agent", agentId: AGENT_ID },
            role: "workspace-approver",
            scope: { _tag: "workspace", workspaceId: WORKSPACE_A },
            lifecycle: { _tag: "active", assignedAt: "2026-07-13T10:00:00.000Z" }
          })
        yield* people.createRoleAssignment(WORKSPACE_A, makeAssignment(ASSIGNMENT_ID), CREATED_AT)
        const valid = yield* people.createRoleAssignment(WORKSPACE_A, makeAssignment(SECOND_ASSIGNMENT_ID), CREATED_AT)

        const roleCanary = "never-return-malformed-role"
        yield* database.sql`UPDATE role_assignments
          SET updated_at = ${roleCanary}
          WHERE workspace_id = ${WORKSPACE_A}
            AND assignment_id = ${ASSIGNMENT_ID}`

        const malformed = yield* people.getRoleAssignment(WORKSPACE_A, ASSIGNMENT_ID).pipe(Effect.result)
        const listed = yield* people.listRoleAssignments(WORKSPACE_A)
        const records = yield* quarantine.list(WORKSPACE_A)

        assert.isTrue(Result.isFailure(malformed))
        if (Result.isFailure(malformed)) assert.instanceOf(malformed.failure, PersistedRecordError)
        assert.deepStrictEqual(listed, [valid])
        assert.lengthOf(records, 1)
        assert.strictEqual(records[0]?.recordKind, "role-assignment")
        assert.strictEqual(records[0]?.diagnosticCode, "role-assignment-schema-invalid")
        assert.notInclude(JSON.stringify({ listed, malformed, records }), roleCanary)
      })
    ))

  it.effect("quarantines malformed persisted avatars without returning their content", () =>
    withRepositories(
      Effect.gen(function*() {
        yield* createWorkspaceAndPlugin
        const database = yield* Database
        const people = yield* PeopleRepository
        const quarantine = yield* QuarantineRepository
        yield* people.createPerson(WORKSPACE_A, person, CREATED_AT)

        const secretCanary = "never-return-corrupt-avatar"
        yield* database.sql`UPDATE persons
          SET avatar_json = ${`{"secret":"${secretCanary}"}`}
          WHERE workspace_id = ${WORKSPACE_A}
            AND person_id = ${person.personId}`

        const result = yield* people.getPerson(WORKSPACE_A, person.personId).pipe(Effect.result)
        assert.isTrue(Result.isFailure(result))
        if (Result.isFailure(result)) assert.instanceOf(result.failure, PersistedRecordError)

        const records = yield* quarantine.list(WORKSPACE_A)
        assert.lengthOf(records, 1)
        assert.strictEqual(records[0]?.recordKind, "person-avatar")
        assert.notInclude(JSON.stringify(records), secretCanary)
        assert.notInclude(JSON.stringify(result), secretCanary)
      })
    ))

  it.effect("falls back from a malformed entity revision without poisoning workspace lists", () =>
    withRepositories(
      Effect.gen(function*() {
        yield* createWorkspaceAndPlugin
        const database = yield* Database
        const entities = yield* EntityRepository
        const quarantine = yield* QuarantineRepository
        yield* entities.create(WORKSPACE_A, {
          entityId: ENTITY_ID,
          entityType: "issue",
          sourceRevision,
          createdAt: CREATED_AT
        })
        yield* entities.updateSourceRevision(WORKSPACE_A, ENTITY_ID, {
          sourceRevision: Schema.decodeSync(SourceRevision)({
            ...Schema.encodeSync(SourceRevision)(sourceRevision),
            revision: "1002",
            lastObservedAt: "2026-07-13T10:03:00.000Z",
            synchronizedAt: "2026-07-13T10:04:00.000Z"
          }),
          expectedRevision: RecordRevision.make(1),
          updatedAt: UPDATED_AT
        })

        const secretCanary = "never-return-malformed-entity-revision"
        yield* database.sql`UPDATE entity_revisions
          SET synchronized_at = ${secretCanary}
          WHERE workspace_id = ${WORKSPACE_A}
            AND entity_id = ${ENTITY_ID}
            AND revision = 2`

        const recovered = yield* entities.get(WORKSPACE_A, ENTITY_ID)
        const listed = yield* entities.list(WORKSPACE_A)
        const records = yield* quarantine.list(WORKSPACE_A)

        assert.strictEqual(recovered.revision, 1)
        assert.strictEqual(recovered.sourceRevision.revision, "1001")
        assert.deepStrictEqual(listed, [recovered])
        assert.lengthOf(records, 1)
        assert.strictEqual(records[0]?.recordKind, "entity-revision")
        assert.strictEqual(records[0]?.recordKey, `${ENTITY_ID}:2`)
        assert.strictEqual(records[0]?.diagnosticCode, "entity-revision-schema-invalid")
        assert.notInclude(JSON.stringify({ listed, records, recovered }), secretCanary)
      })
    ))

  it.effect("quarantines a malformed entity head before trusting immutable revisions", () =>
    withRepositories(
      Effect.gen(function*() {
        yield* createWorkspaceAndPlugin
        const database = yield* Database
        const entities = yield* EntityRepository
        const quarantine = yield* QuarantineRepository
        yield* entities.create(WORKSPACE_A, {
          entityId: ENTITY_ID,
          entityType: "issue",
          sourceRevision,
          createdAt: CREATED_AT
        })

        const secretCanary = " never-return-malformed-entity-head "
        yield* database.sql`UPDATE entities
          SET vendor_immutable_id = ${secretCanary}
          WHERE workspace_id = ${WORKSPACE_A}
            AND entity_id = ${ENTITY_ID}`

        const result = yield* entities.get(WORKSPACE_A, ENTITY_ID).pipe(Effect.result)
        assert.isTrue(Result.isFailure(result))
        if (Result.isFailure(result)) assert.instanceOf(result.failure, PersistedRecordError)

        const records = yield* quarantine.list(WORKSPACE_A)
        assert.lengthOf(records, 1)
        assert.strictEqual(records[0]?.recordKind, "entity-revision")
        assert.strictEqual(records[0]?.recordKey, `${ENTITY_ID}:1`)
        assert.strictEqual(records[0]?.diagnosticCode, "entity-revision-schema-invalid")
        assert.notInclude(JSON.stringify({ records, result }), secretCanary)

        yield* database.sql`UPDATE entities
          SET vendor_immutable_id = ${sourceRevision.vendorImmutableId}
          WHERE workspace_id = ${WORKSPACE_A}
            AND entity_id = ${ENTITY_ID}`
        yield* database.sql`PRAGMA ignore_check_constraints = ON`
        yield* database.sql`UPDATE entities
          SET current_revision = 0
          WHERE workspace_id = ${WORKSPACE_A}
            AND entity_id = ${ENTITY_ID}`
        yield* database.sql`PRAGMA ignore_check_constraints = OFF`

        const invalidRevision = yield* entities.get(WORKSPACE_A, ENTITY_ID).pipe(Effect.result)
        const listed = yield* entities.list(WORKSPACE_A)
        const revisionRecords = yield* quarantine.list(WORKSPACE_A)
        assert.isTrue(Result.isFailure(invalidRevision))
        if (Result.isFailure(invalidRevision)) {
          assert.instanceOf(invalidRevision.failure, PersistedRecordError)
        }
        assert.deepStrictEqual(listed, [])
        assert.lengthOf(revisionRecords, 2)
        assert.isTrue(
          revisionRecords.some((record) => record.recordKind === "entity-revision" && record.recordKey === WORKSPACE_A)
        )
      })
    ))

  it.effect("quarantines malformed content metadata without hiding valid metadata", () =>
    withRepositories(
      Effect.gen(function*() {
        const content = yield* ContentBlobMetadataRepository
        const database = yield* Database
        const quarantine = yield* QuarantineRepository
        const workspaces = yield* WorkspaceRepository
        yield* workspaces.create(WORKSPACE_A, { displayName: PAYMENTS, createdAt: CREATED_AT })
        yield* content.create(WORKSPACE_A, {
          digest: CONTENT_DIGEST,
          storageClass: "durable",
          byteLength: 42,
          mimeType: "application/json",
          createdAt: CREATED_AT,
          lastVerifiedAt: null
        })
        const valid = yield* content.create(WORKSPACE_A, {
          digest: SECOND_CONTENT_DIGEST,
          storageClass: "reproducible-cache",
          byteLength: 7,
          mimeType: "text/plain",
          createdAt: CREATED_AT,
          lastVerifiedAt: null
        })

        const secretCanary = "never-return-malformed-content-metadata"
        yield* database.sql`UPDATE content_blobs
          SET created_at = ${secretCanary}
          WHERE workspace_id = ${WORKSPACE_A}
            AND digest = ${CONTENT_DIGEST}`

        const malformed = yield* content.get(WORKSPACE_A, CONTENT_DIGEST).pipe(Effect.result)
        const listed = yield* content.list(WORKSPACE_A)
        const records = yield* quarantine.list(WORKSPACE_A)

        assert.isTrue(Result.isFailure(malformed))
        if (Result.isFailure(malformed)) {
          assert.instanceOf(malformed.failure, PersistedRecordError)
        }
        assert.deepStrictEqual(listed, [valid])
        assert.lengthOf(records, 1)
        assert.strictEqual(records[0]?.recordKind, "content-metadata")
        assert.strictEqual(records[0]?.recordKey, CONTENT_DIGEST)
        assert.strictEqual(records[0]?.diagnosticCode, "content-metadata-schema-invalid")
        assert.notInclude(JSON.stringify({ listed, malformed, records }), secretCanary)
      })
    ))

  it.effect("keys diff content cache entries by immutable revision and replaces repaired content", () =>
    withRepositories(
      Effect.gen(function*() {
        yield* createWorkspaceAndPlugin
        const content = yield* ContentBlobMetadataRepository
        const cache = yield* DiffContentCacheRepository
        const { sql } = yield* Database
        yield* content.create(WORKSPACE_A, {
          digest: CONTENT_DIGEST,
          storageClass: "reproducible-cache",
          byteLength: 6,
          mimeType: "text/plain",
          createdAt: CREATED_AT,
          lastVerifiedAt: null
        })
        yield* content.create(WORKSPACE_A, {
          digest: SECOND_CONTENT_DIGEST,
          storageClass: "reproducible-cache",
          byteLength: 8,
          mimeType: "text/plain",
          createdAt: CREATED_AT,
          lastVerifiedAt: null
        })
        const maximumRevision = Revision.make("r".repeat(512))
        const key = {
          workspaceId: WORKSPACE_A,
          pluginConnectionId: PLUGIN_ID,
          vendorImmutableId: VendorImmutableId.make("184"),
          revision: maximumRevision,
          anchor: DiffFileAnchor.make(`sha256:${"d".repeat(64)}`),
          status: "modified",
          side: "after"
        } satisfies DiffContentCacheKey

        assert.throws(() => Schema.decodeUnknownSync(Revision)("r".repeat(513)))
        assert.isTrue(Option.isNone(yield* cache.get(key)))
        yield* cache.put(key, CONTENT_DIGEST)
        assert.deepStrictEqual(yield* cache.get(key), Option.some(CONTENT_DIGEST))
        assert.isTrue(Option.isNone(yield* cache.get({ ...key, revision: Revision.make("revision-10") })))
        assert.isTrue(Option.isNone(yield* cache.get({ ...key, status: "deleted" })))
        yield* cache.put(key, SECOND_CONTENT_DIGEST)
        assert.deepStrictEqual(yield* cache.get(key), Option.some(SECOND_CONTENT_DIGEST))
        assert.deepStrictEqual(yield* cache.pendingCleanup(), [
          {
            workspaceId: WORKSPACE_A,
            digest: CONTENT_DIGEST
          }
        ])
        const referencePlan = yield* sql
          .unsafe(
            `EXPLAIN QUERY PLAN
            SELECT 1
            FROM diff_content_cache_entries
            WHERE workspace_id = ? AND content_digest = ?
            LIMIT 1`,
            [WORKSPACE_A, CONTENT_DIGEST]
          )
          .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(ExplainQueryPlanRow))))
        assert.include(referencePlan.map(({ detail }) => detail).join("\n"), "diff_content_cache_content_digest_idx")
      })
    ))

  descriptorIt.effect(
    "evicts oldest cache entries and only removes unreferenced reproducible blobs",
    () =>
      withRepositories(
        Effect.gen(function*() {
          yield* createWorkspaceAndPlugin
          const blobs = yield* BlobStore
          const cache = yield* DiffContentCacheRepository
          const content = yield* ContentBlobMetadataRepository
          const contentStore = yield* ContentStore
          const database = yield* Database

          const unique = yield* blobs.put(WORKSPACE_A, new Uint8Array([1]), "reproducible-cache")
          const durable = yield* blobs.put(WORKSPACE_A, new Uint8Array([2]), "durable")
          const shared = yield* blobs.put(WORKSPACE_A, new Uint8Array([3]), "reproducible-cache")
          const recent = yield* blobs.put(WORKSPACE_A, new Uint8Array([4]), "reproducible-cache")
          for (const stored of [unique, durable, shared, recent]) {
            yield* content.create(WORKSPACE_A, {
              digest: stored.ref.digest,
              storageClass: stored.ref.classification,
              byteLength: stored.ref.sizeBytes,
              mimeType: "text/plain",
              createdAt: CREATED_AT,
              lastVerifiedAt: null
            })
          }
          const durableRemoval = yield* database
            .transaction(contentStore.removeReproducible(WORKSPACE_A, durable.ref.digest))
            .pipe(Effect.result)
          assert.isTrue(Result.isFailure(durableRemoval))
          if (Result.isFailure(durableRemoval)) {
            assert.instanceOf(durableRemoval.failure, ContentMetadataMismatchError)
          }
          yield* database.transaction(contentStore.removeReproducible(WORKSPACE_A, BlobDigest.make("f".repeat(64))))
          assert.deepStrictEqual(yield* blobs.readAll(WORKSPACE_A, durable.ref.digest), new Uint8Array([2]))

          const keyFor = (anchorCharacter: string): DiffContentCacheKey => ({
            workspaceId: WORKSPACE_A,
            pluginConnectionId: PLUGIN_ID,
            vendorImmutableId: VendorImmutableId.make("184"),
            revision: Revision.make("revision-9"),
            anchor: DiffFileAnchor.make(`sha256:${anchorCharacter.repeat(64)}`),
            status: "modified",
            side: "after"
          })
          const uniqueKey = keyFor("1")
          const durableKey = keyFor("2")
          const sharedOldKey = keyFor("3")
          const sharedRecentKey = keyFor("4")
          const recentKey = keyFor("5")

          yield* cache.put(uniqueKey, unique.ref.digest, 100)
          yield* cache.put(durableKey, durable.ref.digest, 100)
          yield* cache.put(sharedOldKey, shared.ref.digest, 100)
          yield* cache.put(sharedRecentKey, shared.ref.digest, 100)
          yield* database.sql`UPDATE diff_content_cache_entries
          SET cached_at = CASE file_anchor
            WHEN ${uniqueKey.anchor} THEN '1960-07-13T10:00:00.000Z'
            WHEN ${durableKey.anchor} THEN '1960-07-13T10:01:00.000Z'
            WHEN ${sharedOldKey.anchor} THEN '1960-07-13T10:02:00.000Z'
            WHEN ${sharedRecentKey.anchor} THEN '1960-07-13T10:03:00.000Z'
            ELSE cached_at
          END
          WHERE workspace_id = ${WORKSPACE_A}`

          yield* cache.put(recentKey, recent.ref.digest, 2)
          yield* sweepDiffContentCacheCleanup(database, contentStore, cache)

          assert.isTrue(Option.isNone(yield* cache.get(uniqueKey)))
          assert.isTrue(Option.isNone(yield* cache.get(durableKey)))
          assert.isTrue(Option.isNone(yield* cache.get(sharedOldKey)))
          assert.deepStrictEqual(yield* cache.get(sharedRecentKey), Option.some(shared.ref.digest))
          assert.deepStrictEqual(yield* cache.get(recentKey), Option.some(recent.ref.digest))

          const removedMetadata = yield* content.get(WORKSPACE_A, unique.ref.digest).pipe(Effect.result)
          const removedBytes = yield* blobs.readAll(WORKSPACE_A, unique.ref.digest).pipe(Effect.result)
          assert.isTrue(Result.isFailure(removedMetadata))
          if (Result.isFailure(removedMetadata)) {
            assert.strictEqual(removedMetadata.failure._tag, "RecordNotFoundError")
          }
          assert.isTrue(Result.isFailure(removedBytes))
          if (Result.isFailure(removedBytes)) {
            assert.strictEqual(removedBytes.failure._tag, "BlobNotFoundError")
          }

          assert.strictEqual((yield* content.get(WORKSPACE_A, durable.ref.digest)).storageClass, "durable")
          assert.deepStrictEqual(yield* blobs.readAll(WORKSPACE_A, durable.ref.digest), new Uint8Array([2]))
          assert.deepStrictEqual(yield* blobs.readAll(WORKSPACE_A, shared.ref.digest), new Uint8Array([3]))
          assert.deepStrictEqual(yield* blobs.readAll(WORKSPACE_A, recent.ref.digest), new Uint8Array([4]))
        })
      )
  )

  descriptorIt.effect(
    "keeps failed cache cleanup durable and retries it after storage recovers",
    () =>
      withRepositories(
        Effect.gen(function*() {
          yield* createWorkspaceAndPlugin
          const blobs = yield* BlobStore
          const cache = yield* DiffContentCacheRepository
          const content = yield* ContentStore
          const database = yield* Database
          const workspaces = yield* WorkspaceRepository
          yield* workspaces.create(WORKSPACE_B, {
            displayName: IDENTITY,
            createdAt: CREATED_AT
          })
          const published = yield* content.put(WORKSPACE_A, {
            bytes: new Uint8Array([9]),
            classification: "reproducible-cache",
            mimeType: "text/plain",
            createdAt: CREATED_AT
          })
          yield* cache.requestCleanup(WORKSPACE_A, published.metadata.digest)
          const later = yield* content.put(WORKSPACE_B, {
            bytes: new Uint8Array([12]),
            classification: "reproducible-cache",
            mimeType: "text/plain",
            createdAt: CREATED_AT
          })
          yield* cache.requestCleanup(WORKSPACE_B, later.metadata.digest)

          yield* sweepDiffContentCacheCleanup(
            database,
            {
              removeReproducible: (workspaceId, digest) =>
                digest === published.metadata.digest
                  ? Effect.fail(
                    new BlobStoreIoError({
                      operation: "injected cache cleanup",
                      message: "platform storage operation failed"
                    })
                  )
                  : content.removeReproducible(workspaceId, digest)
            },
            cache
          )
          assert.deepStrictEqual(yield* blobs.readAll(WORKSPACE_A, published.metadata.digest), new Uint8Array([9]))
          assert.strictEqual(
            (yield* content.getMetadata(WORKSPACE_A, published.metadata.digest)).digest,
            published.metadata.digest
          )
          assert.deepStrictEqual(yield* cache.pendingCleanup(), [
            {
              workspaceId: WORKSPACE_A,
              digest: published.metadata.digest
            }
          ])
          assert.isTrue(
            Result.isFailure(yield* content.getMetadata(WORKSPACE_B, later.metadata.digest).pipe(Effect.result))
          )
          assert.isTrue(Result.isFailure(yield* blobs.readAll(WORKSPACE_B, later.metadata.digest).pipe(Effect.result)))

          yield* sweepDiffContentCacheCleanup(database, content, cache)
          assert.isTrue(
            Result.isFailure(yield* content.getMetadata(WORKSPACE_A, published.metadata.digest).pipe(Effect.result))
          )
          assert.isTrue(
            Result.isFailure(yield* blobs.readAll(WORKSPACE_A, published.metadata.digest).pipe(Effect.result))
          )
          assert.deepStrictEqual(yield* cache.pendingCleanup(), [])
        })
      )
  )

  descriptorIt.effect("keeps malformed cleanup identities in the typed error channel", () =>
    withRepositories(
      Effect.gen(function*() {
        const cache = yield* DiffContentCacheRepository
        const content = yield* ContentStore
        const database = yield* Database
        const workspaces = yield* WorkspaceRepository
        yield* workspaces.create(WORKSPACE_A, {
          displayName: PAYMENTS,
          createdAt: CREATED_AT
        })
        const published = yield* content.put(WORKSPACE_A, {
          bytes: new Uint8Array([15]),
          classification: "reproducible-cache",
          mimeType: "application/octet-stream",
          createdAt: CREATED_AT
        })
        yield* cache.requestCleanup(WORKSPACE_A, published.metadata.digest)
        yield* database.sql`PRAGMA foreign_keys = OFF`
        yield* database.sql`UPDATE diff_content_cache_cleanup
          SET workspace_id = '00000000-0000-4000-8000-000000000000'
          WHERE workspace_id = ${WORKSPACE_A}
            AND content_digest = ${published.metadata.digest}`
        yield* database.sql`PRAGMA foreign_keys = ON`

        const pending = yield* cache.pendingCleanup().pipe(Effect.result)
        assert.isTrue(Result.isFailure(pending))
        if (Result.isFailure(pending)) {
          assert.instanceOf(pending.failure, PersistedRecordError)
        }
      })
    ))

  it.effect("reclaims publication orphans when cache mapping insertion fails", () =>
    withRepositories(
      Effect.gen(function*() {
        yield* createWorkspaceAndPlugin
        const blobs = yield* BlobStore
        const cache = yield* DiffContentCacheRepository
        const content = yield* ContentStore
        const database = yield* Database
        const expectedDigest = ContentBlobDigest.make(
          "01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b"
        )
        const key = {
          workspaceId: WORKSPACE_A,
          pluginConnectionId: PLUGIN_ID,
          vendorImmutableId: VendorImmutableId.make("184"),
          revision: Revision.make("revision-cache-failure"),
          anchor: DiffFileAnchor.make(`sha256:${"6".repeat(64)}`),
          status: "modified",
          side: "after"
        } satisfies DiffContentCacheKey

        const failed = yield* Effect.acquireUseRelease(
          database.sql`CREATE TRIGGER fail_diff_content_cache_insert
            BEFORE INSERT ON diff_content_cache_entries
            BEGIN
              SELECT RAISE(ABORT, 'injected cache mapping failure');
            END`,
          () =>
            putContentAndSweepDiffContentCache(database, content, cache, key, {
              bytes: new Uint8Array([10]),
              classification: "reproducible-cache",
              mimeType: "text/plain",
              createdAt: CREATED_AT
            }).pipe(Effect.result),
          () => database.sql`DROP TRIGGER fail_diff_content_cache_insert`.pipe(Effect.ignore)
        )
        assert.isTrue(Result.isFailure(failed))
        assert.isTrue(Result.isFailure(yield* content.getMetadata(WORKSPACE_A, expectedDigest).pipe(Effect.result)))
        assert.isTrue(Result.isFailure(yield* blobs.readAll(WORKSPACE_A, expectedDigest).pipe(Effect.result)))
        assert.deepStrictEqual(yield* cache.pendingCleanup(), [])
      })
    ))

  descriptorIt.effect("keeps one transaction open from cache staging through mapping", () =>
    withRepositories(
      Effect.gen(function*() {
        yield* createWorkspaceAndPlugin
        const blobs = yield* BlobStore
        const cache = yield* DiffContentCacheRepository
        const content = yield* ContentStore
        const database = yield* Database
        const key = {
          workspaceId: WORKSPACE_A,
          pluginConnectionId: PLUGIN_ID,
          vendorImmutableId: VendorImmutableId.make("184"),
          revision: Revision.make("revision-concurrent-cleanup"),
          anchor: DiffFileAnchor.make(`sha256:${"8".repeat(64)}`),
          status: "modified",
          side: "after"
        } satisfies DiffContentCacheKey
        const completedCoordinatorTransactions = yield* Ref.make(0)
        const trackedDatabase = Database.of({
          ...database,
          transaction: (effect) =>
            database.transaction(effect).pipe(
              Effect.ensuring(
                Ref.update(completedCoordinatorTransactions, (count) => count + 1)
              )
            )
        })
        const lockObservingCache = DiffContentCacheRepository.of({
          ...cache,
          put: (...args) =>
            Ref.get(completedCoordinatorTransactions).pipe(
              Effect.flatMap((completedTransactions) =>
                completedTransactions === 0
                  ? cache.put(...args)
                  : Effect.die("Cache mapping began after completing its staging transaction")
              )
            )
        })
        const stored = yield* putContentAndSweepDiffContentCache(
          trackedDatabase,
          content,
          lockObservingCache,
          key,
          {
            bytes: new Uint8Array([16]),
            classification: "reproducible-cache",
            mimeType: "text/plain",
            createdAt: CREATED_AT
          }
        )

        assert.deepStrictEqual(yield* cache.get(key), Option.some(stored.metadata.digest))
        assert.deepStrictEqual(yield* blobs.readAll(WORKSPACE_A, stored.metadata.digest), new Uint8Array([16]))
        assert.deepStrictEqual(yield* cache.pendingCleanup(), [])
      })
    ))

  descriptorIt.effect(
    "keeps cleanup intent and direct cache mapping in one transaction",
    () =>
      withRepositories(
        Effect.gen(function*() {
          yield* createWorkspaceAndPlugin
          const cache = yield* DiffContentCacheRepository
          const content = yield* ContentStore
          const database = yield* Database
          const published = yield* content.put(WORKSPACE_A, {
            bytes: new Uint8Array([19]),
            classification: "reproducible-cache",
            mimeType: "text/plain",
            createdAt: CREATED_AT
          })
          const key = {
            workspaceId: WORKSPACE_A,
            pluginConnectionId: PLUGIN_ID,
            vendorImmutableId: VendorImmutableId.make("184"),
            revision: Revision.make("revision-direct-mapping"),
            anchor: DiffFileAnchor.make(`sha256:${"9".repeat(64)}`),
            status: "modified",
            side: "after"
          } satisfies DiffContentCacheKey
          const activeCoordinatorTransactions = yield* Ref.make(0)
          const trackedDatabase = Database.of({
            ...database,
            transaction: (effect) =>
              Ref.update(activeCoordinatorTransactions, (count) => count + 1).pipe(
                Effect.andThen(database.transaction(effect)),
                Effect.ensuring(
                  Ref.update(activeCoordinatorTransactions, (count) => count - 1)
                )
              )
          })
          const lockObservingCache = DiffContentCacheRepository.of({
            ...cache,
            put: (...args) =>
              Ref.get(activeCoordinatorTransactions).pipe(
                Effect.flatMap((activeTransactions) =>
                  activeTransactions === 1
                    ? cache.put(...args)
                    : Effect.die("Direct cache mapping ran outside its cleanup-intent transaction")
                )
              )
          })

          yield* putAndSweepDiffContentCache(
            trackedDatabase,
            content,
            lockObservingCache,
            key,
            published.metadata.digest
          )

          assert.deepStrictEqual(yield* cache.get(key), Option.some(published.metadata.digest))
          assert.deepStrictEqual(yield* cache.pendingCleanup(), [])
        })
      )
  )

  descriptorIt.effect(
    "rotates a full failed cleanup batch so later workspaces still progress",
    () =>
      withRepositories(
        Effect.gen(function*() {
          yield* createWorkspaceAndPlugin
          const cache = yield* DiffContentCacheRepository
          const content = yield* ContentStore
          const database = yield* Database
          const workspaces = yield* WorkspaceRepository
          yield* workspaces.create(WORKSPACE_B, {
            displayName: IDENTITY,
            createdAt: CREATED_AT
          })

          const failingDigests = new Set<string>()
          for (let index = 0; index < MaximumDiffContentCacheCleanupBatch; index += 1) {
            const published = yield* content.put(WORKSPACE_A, {
              bytes: new Uint8Array([13, index]),
              classification: "reproducible-cache",
              mimeType: "application/octet-stream",
              createdAt: CREATED_AT
            })
            failingDigests.add(published.metadata.digest)
            yield* cache.requestCleanup(WORKSPACE_A, published.metadata.digest)
          }
          const later = yield* content.put(WORKSPACE_B, {
            bytes: new Uint8Array([14]),
            classification: "reproducible-cache",
            mimeType: "application/octet-stream",
            createdAt: CREATED_AT
          })
          yield* cache.requestCleanup(WORKSPACE_B, later.metadata.digest)

          const removeUnlessPoisoned = {
            removeReproducible: (workspaceId: WorkspaceId, digest: BlobDigest) =>
              failingDigests.has(digest)
                ? Effect.fail(
                  new BlobStoreIoError({
                    operation: "injected full cache cleanup batch",
                    message: "platform storage operation failed"
                  })
                )
                : content.removeReproducible(workspaceId, digest)
          }
          yield* sweepDiffContentCacheCleanup(database, removeUnlessPoisoned, cache)
          yield* sweepDiffContentCacheCleanup(database, removeUnlessPoisoned, cache)

          assert.isTrue(
            Result.isFailure(yield* content.getMetadata(WORKSPACE_B, later.metadata.digest).pipe(Effect.result))
          )
          const pending = yield* cache.pendingCleanup(MaximumDiffContentCacheCleanupBatch + 1)
          assert.lengthOf(pending, MaximumDiffContentCacheCleanupBatch)
          assert.isTrue(pending.every(({ workspaceId }) => workspaceId === WORKSPACE_A))

          yield* sweepDiffContentCacheCleanup(database, content, cache)
          assert.deepStrictEqual(yield* cache.pendingCleanup(), [])
        })
      ),
    { timeout: 30_000 }
  )

  descriptorIt.effect("publishes durable bytes before acquiring the writer transaction", () =>
    withRepositories(
      Effect.gen(function*() {
        yield* createWorkspaceAndPlugin
        const database = yield* Database
        const rawBlobs = yield* BlobStore
        const activeWriterTransactions = yield* Ref.make(0)
        const trackedDatabaseLayer = Layer.succeed(
          Database,
          Database.of({
            ...database,
            transaction: (effect) =>
              Ref.update(activeWriterTransactions, (count) => count + 1).pipe(
                Effect.andThen(database.transaction(effect)),
                Effect.ensuring(
                  Ref.update(activeWriterTransactions, (count) => count - 1)
                )
              )
          })
        )
        const observingBlobs = Layer.succeed(
          BlobStore,
          BlobStore.of({
            ...rawBlobs,
            put: (...args) =>
              Ref.get(activeWriterTransactions).pipe(
                Effect.flatMap((activeTransactions) =>
                  activeTransactions === 0
                    ? rawBlobs.put(...args)
                    : Effect.die("Durable blob publication held the global writer transaction")
                )
              )
          })
        )
        const trackedFoundation = QuarantineRepository.layer.pipe(Layer.provideMerge(trackedDatabaseLayer))
        const trackedMetadata = ContentBlobMetadataRepository.layer.pipe(Layer.provide(trackedFoundation))
        const trackedContentContext = yield* Layer.build(
          Layer.fresh(ContentStore.layer).pipe(
            Layer.provide(Layer.mergeAll(trackedMetadata, observingBlobs, trackedDatabaseLayer))
          )
        )
        const trackedContent = Context.get(trackedContentContext, ContentStore)
        const stored = yield* trackedContent.put(WORKSPACE_A, {
          bytes: new Uint8Array([17]),
          classification: "durable",
          mimeType: "text/plain",
          createdAt: CREATED_AT
        })

        assert.strictEqual(yield* Ref.get(activeWriterTransactions), 0)
        assert.deepStrictEqual(yield* rawBlobs.readAll(WORKSPACE_A, stored.metadata.digest), new Uint8Array([17]))
      })
    ))

  descriptorIt.effect(
    "retries durable finalization when same-digest cache cleanup wins the first publication race",
    () =>
      withRepositories(
        Effect.gen(function*() {
          yield* createWorkspaceAndPlugin
          const bytes = new Uint8Array([18])
          const cache = yield* DiffContentCacheRepository
          const content = yield* ContentStore
          const database = yield* Database
          const config = yield* RepositoryTestConfig
          const firstPublicationReady = yield* Deferred.make<void>()
          const releaseFirstPublication = yield* Deferred.make<void>()
          const putCount = yield* Ref.make(0)
          const cached = yield* content.put(WORKSPACE_A, {
            bytes,
            classification: "reproducible-cache",
            mimeType: "text/plain",
            createdAt: CREATED_AT
          })
          yield* cache.requestCleanup(WORKSPACE_A, cached.metadata.digest)

          const secondaryDatabaseContext = yield* Layer.build(
            databaseLayer({
              ...config,
              maxConnections: 1
            })
          )
          const secondaryDatabase = Context.get(secondaryDatabaseContext, Database)
          const secondaryDatabaseLayer = Layer.succeed(Database, secondaryDatabase)
          const secondaryBlobContext = yield* Layer.build(BlobStore.layer({ blobRoot: config.blobRoot }))
          const rawSecondaryBlobs = Context.get(secondaryBlobContext, BlobStore)
          const gatedSecondaryBlobs = Layer.succeed(
            BlobStore,
            BlobStore.of({
              ...rawSecondaryBlobs,
              put: (...args) =>
                rawSecondaryBlobs.put(...args).pipe(
                  Effect.flatMap((published) =>
                    Ref.getAndUpdate(putCount, (count) => count + 1).pipe(
                      Effect.flatMap((count) =>
                        count === 0
                          ? Deferred.succeed(firstPublicationReady, undefined).pipe(
                            Effect.andThen(Deferred.await(releaseFirstPublication))
                          )
                          : Effect.void
                      ),
                      Effect.as(published)
                    )
                  )
                )
            })
          )
          const secondaryFoundation = QuarantineRepository.layer.pipe(Layer.provideMerge(secondaryDatabaseLayer))
          const secondaryMetadata = ContentBlobMetadataRepository.layer.pipe(Layer.provide(secondaryFoundation))
          const secondaryContentContext = yield* Layer.build(
            Layer.fresh(ContentStore.layer).pipe(
              Layer.provide(Layer.mergeAll(secondaryMetadata, gatedSecondaryBlobs, secondaryDatabaseLayer))
            )
          )
          const secondaryContent = Context.get(secondaryContentContext, ContentStore)
          const durablePublication = yield* Effect.forkChild(
            secondaryContent.put(WORKSPACE_A, {
              bytes,
              classification: "durable",
              mimeType: "text/plain",
              createdAt: CREATED_AT
            })
          )
          yield* Deferred.await(firstPublicationReady)
          yield* sweepDiffContentCacheCleanup(database, content, cache)
          yield* Deferred.succeed(releaseFirstPublication, undefined)
          const durable = yield* Fiber.join(durablePublication)

          assert.strictEqual(yield* Ref.get(putCount), 2)
          assert.strictEqual(durable.metadata.storageClass, "durable")
          assert.deepStrictEqual(yield* rawSecondaryBlobs.readAll(WORKSPACE_A, durable.metadata.digest), bytes)
          assert.deepStrictEqual(yield* cache.pendingCleanup(), [])
        })
      )
  )

  descriptorIt.effect(
    "acquires the writer lock on an independent connection before republishing",
    () =>
      withRepositories(
        Effect.gen(function*() {
          yield* createWorkspaceAndPlugin
          const bytes = new Uint8Array([11])
          const blobs = yield* BlobStore
          const cache = yield* DiffContentCacheRepository
          const content = yield* ContentStore
          const database = yield* Database
          const config = yield* RepositoryTestConfig
          const secondaryDatabase = databaseLayer({
            ...config,
            maxConnections: 1
          })
          const secondaryDatabaseContext = yield* Layer.build(secondaryDatabase)
          const secondaryDatabaseService = Context.get(secondaryDatabaseContext, Database)
          const secondaryDatabaseLayer = Layer.succeed(Database, secondaryDatabaseService)
          const secondaryBlobContext = yield* Layer.build(BlobStore.layer({ blobRoot: config.blobRoot }))
          const rawSecondaryBlobs = Context.get(secondaryBlobContext, BlobStore)
          const secondaryBlobs = Layer.succeed(
            BlobStore,
            BlobStore.of({
              ...rawSecondaryBlobs,
              put: (...args) =>
                secondaryDatabaseService.sql`SELECT observed
                FROM content_writer_lock_audit`.pipe(
                  Effect.mapError(
                    () =>
                      new BlobStoreIoError({
                        operation: "observe content writer lock",
                        message: "platform storage operation failed"
                      })
                  ),
                  Effect.flatMap((rows) =>
                    rows.length === 1
                      ? rawSecondaryBlobs.put(...args)
                      : Effect.die("ContentStore reached blob publication before acquiring its writer lock")
                  )
                )
            })
          )
          const secondaryFoundation = QuarantineRepository.layer.pipe(Layer.provideMerge(secondaryDatabaseLayer))
          const secondaryMetadata = ContentBlobMetadataRepository.layer.pipe(Layer.provide(secondaryFoundation))
          const secondaryContentContext = yield* Layer.build(
            Layer.fresh(ContentStore.layer).pipe(
              Layer.provide(Layer.mergeAll(secondaryMetadata, secondaryBlobs, secondaryDatabaseLayer))
            )
          )
          const secondaryContent = Context.get(secondaryContentContext, ContentStore)
          const first = yield* content.put(WORKSPACE_A, {
            bytes,
            classification: "reproducible-cache",
            mimeType: "text/plain",
            createdAt: CREATED_AT
          })
          yield* cache.requestCleanup(WORKSPACE_A, first.metadata.digest)
          yield* sweepDiffContentCacheCleanup(database, content, cache)

          const { lockAudit, second } = yield* Effect.acquireUseRelease(
            database.transaction(
              Effect.gen(function*() {
                yield* database.sql`CREATE TABLE content_writer_lock_audit (
                observed INTEGER NOT NULL
              )`
                yield* database.sql`CREATE TRIGGER observe_content_writer_lock
                AFTER UPDATE OF workspace_id ON workspaces
                WHEN NEW.workspace_id = '01890f6f-6d6a-7cc0-98d2-000000000001'
                BEGIN
                  INSERT INTO content_writer_lock_audit (observed) VALUES (1);
                END`
              })
            ),
            () =>
              Effect.gen(function*() {
                const second = yield* secondaryContent.put(WORKSPACE_A, {
                  bytes,
                  classification: "reproducible-cache",
                  mimeType: "text/plain",
                  createdAt: CREATED_AT
                })
                const lockAudit = yield* database.sql`SELECT observed
                FROM content_writer_lock_audit`
                return { lockAudit, second }
              }),
            () =>
              database
                .transaction(
                  Effect.gen(function*() {
                    yield* database.sql`DROP TRIGGER observe_content_writer_lock`
                    yield* database.sql`DROP TABLE content_writer_lock_audit`
                  })
                )
                .pipe(Effect.ignore)
          )
          assert.deepStrictEqual(lockAudit, [{ observed: 1 }])
          assert.strictEqual(second.metadata.digest, first.metadata.digest)

          const key = {
            workspaceId: WORKSPACE_A,
            pluginConnectionId: PLUGIN_ID,
            vendorImmutableId: VendorImmutableId.make("184"),
            revision: Revision.make("revision-republished"),
            anchor: DiffFileAnchor.make(`sha256:${"7".repeat(64)}`),
            status: "modified",
            side: "after"
          } satisfies DiffContentCacheKey
          yield* cache.put(key, second.metadata.digest)
          assert.deepStrictEqual(yield* cache.get(key), Option.some(second.metadata.digest))
          assert.deepStrictEqual(yield* blobs.readAll(WORKSPACE_A, second.metadata.digest), bytes)
        })
      )
  )
})
