import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert, describe, it } from "@effect/vitest"
import { Effect, FileSystem, Layer, Result, Schema } from "effect"

import { Person, RoleAssignment } from "../../src/domain/actors.js"
import { AgentId, EntityId, PluginConnectionId, RoleAssignmentId, WorkspaceId } from "../../src/domain/identifiers.js"
import { SourceRevision } from "../../src/domain/sourceRevision.js"
import { UtcTimestamp } from "../../src/domain/utcTimestamp.js"
import { Database, databaseLayer } from "../../src/server/persistence/Database.js"
import {
  PersistedRecordError,
  RecordNotFoundError,
  RevisionConflictError,
  SourceIdentityMismatchError
} from "../../src/server/persistence/errors.js"
import { BlobDigest } from "../../src/server/persistence/object-store/BlobDigest.js"
import { ContentBlobMetadataRepository } from "../../src/server/persistence/repositories/contentBlobMetadataRepository.js"
import { EntityRepository } from "../../src/server/persistence/repositories/entityRepository.js"
import {
  PluginConnectionDisplayName,
  RecordRevision,
  WorkspaceName
} from "../../src/server/persistence/repositories/models.js"
import { PeopleRepository } from "../../src/server/persistence/repositories/peopleRepository.js"
import { PluginConnectionRepository } from "../../src/server/persistence/repositories/pluginConnectionRepository.js"
import { QuarantineRepository } from "../../src/server/persistence/repositories/quarantineRepository.js"
import { WorkspaceRepository } from "../../src/server/persistence/repositories/workspaceRepository.js"

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
    blobRoot: `${root}/blobs`,
    busyTimeoutMilliseconds: 5_000,
    databaseUrl: `file:${root}/control-center.db`,
    maxConnections: 1
  }
})

const withRepositories = <Success, Failure>(
  use: Effect.Effect<
    Success,
    Failure,
    | EntityRepository
    | ContentBlobMetadataRepository
    | Database
    | PeopleRepository
    | PluginConnectionRepository
    | QuarantineRepository
    | WorkspaceRepository
  >
) =>
  Effect.gen(function*() {
    const config = yield* testConfig
    const database = databaseLayer(config)
    const foundation = QuarantineRepository.layer.pipe(Layer.provideMerge(database))
    const content = ContentBlobMetadataRepository.layer.pipe(Layer.provide(foundation))
    const entities = EntityRepository.layer.pipe(Layer.provide(foundation))
    const people = PeopleRepository.layer.pipe(Layer.provide(foundation))
    const plugins = PluginConnectionRepository.layer.pipe(Layer.provide(foundation))
    const workspaces = WorkspaceRepository.layer.pipe(Layer.provide(foundation))
    const repositories = Layer.mergeAll(
      foundation,
      content,
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

        const missing = yield* workspaces.get(
          Schema.decodeSync(WorkspaceId)("01890f6f-6d6a-7cc0-98d2-000000000009")
        ).pipe(Effect.result)
        assert.isTrue(Result.isFailure(missing))
        if (Result.isFailure(missing)) assert.instanceOf(missing.failure, RecordNotFoundError)

        const updated = yield* workspaces.updateDisplayName(WORKSPACE_A, {
          displayName: WorkspaceName.make("Payments Platform"),
          expectedRevision: RecordRevision.make(1),
          updatedAt: UPDATED_AT
        })
        assert.strictEqual(updated.revision, 2)
        assert.strictEqual((yield* workspaces.get(WORKSPACE_B)).displayName, "Identity")

        const stale = yield* workspaces.updateDisplayName(WORKSPACE_A, {
          displayName: WorkspaceName.make("Stale write"),
          expectedRevision: RecordRevision.make(1),
          updatedAt: UPDATED_AT
        }).pipe(Effect.result)
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

        const mismatched = yield* entities.updateSourceRevision(WORKSPACE_A, ENTITY_ID, {
          sourceRevision: Schema.decodeSync(SourceRevision)({
            ...Schema.encodeSync(SourceRevision)(sourceRevision),
            vendorImmutableId: "PAY-99"
          }),
          expectedRevision: RecordRevision.make(1),
          updatedAt: UPDATED_AT
        }).pipe(Effect.result)
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
        const valid = yield* people.createRoleAssignment(
          WORKSPACE_A,
          makeAssignment(SECOND_ASSIGNMENT_ID),
          CREATED_AT
        )

        const roleCanary = "never-return-malformed-role"
        yield* database.sql`UPDATE role_assignments
          SET updated_at = ${roleCanary}
          WHERE workspace_id = ${WORKSPACE_A}
            AND assignment_id = ${ASSIGNMENT_ID}`

        const malformed = yield* people.getRoleAssignment(
          WORKSPACE_A,
          ASSIGNMENT_ID
        ).pipe(Effect.result)
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
})
