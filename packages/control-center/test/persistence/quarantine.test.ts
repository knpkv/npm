import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert, describe, it } from "@effect/vitest"
import { Effect, FileSystem, Layer, Result, Schema } from "effect"

import { RoleAssignment } from "../../src/domain/actors.js"
import {
  AgentId,
  EnvironmentId,
  PluginConnectionId,
  ReleaseId,
  RoleAssignmentId,
  WorkspaceId
} from "../../src/domain/identifiers.js"
import { Release } from "../../src/domain/release.js"
import { deriveReleaseRelay } from "../../src/domain/releaseRelay.js"
import { UtcTimestamp } from "../../src/domain/utcTimestamp.js"
import { Database, databaseLayer } from "../../src/server/persistence/Database.js"
import {
  PersistedRecordError,
  PersistenceOperationError,
  RevisionConflictError,
  SourceIdentityMismatchError
} from "../../src/server/persistence/errors.js"
import { BlobDigest } from "../../src/server/persistence/object-store/BlobDigest.js"
import { RecordRevision, WorkspaceName } from "../../src/server/persistence/repositories/models.js"
import { PeopleRepository } from "../../src/server/persistence/repositories/peopleRepository.js"
import { QuarantineRepository } from "../../src/server/persistence/repositories/quarantineRepository.js"
import { ReleaseRepository } from "../../src/server/persistence/repositories/releaseRepository.js"
import { WorkspaceRepository } from "../../src/server/persistence/repositories/workspaceRepository.js"

const WORKSPACE_ID = Schema.decodeSync(WorkspaceId)("01890f6f-6d6a-7cc0-98d2-000000000011")
const RELEASE_ID = Schema.decodeSync(ReleaseId)("01890f6f-6d6a-7cc0-98d2-000000000012")
const ENVIRONMENT_ID = Schema.decodeSync(EnvironmentId)("01890f6f-6d6a-7cc0-98d2-000000000013")
const PLUGIN_ID = Schema.decodeSync(PluginConnectionId)("01890f6f-6d6a-7cc0-98d2-000000000014")
const AGENT_ID = Schema.decodeSync(AgentId)("01890f6f-6d6a-7cc0-98d2-000000000015")
const ASSIGNMENT_ID = Schema.decodeSync(RoleAssignmentId)("01890f6f-6d6a-7cc0-98d2-000000000016")
const EARLIER = Schema.decodeSync(UtcTimestamp)("2026-07-13T09:00:00.000Z")
const LATER = Schema.decodeSync(UtcTimestamp)("2026-07-13T11:00:00.000Z")
const DIGEST = Schema.decodeSync(BlobDigest)("a".repeat(64))

const DiagnosticFixture = Schema.Struct({
  recordKind: Schema.Literal("release-revision"),
  recordKey: Schema.String,
  schemaVersion: Schema.Literal(1),
  payloadDigest: BlobDigest,
  diagnosticCode: Schema.Literal("schema-decode-failed"),
  diagnosticSummary: Schema.Literal("Stored release snapshot failed schema validation.")
})

const release = (version: string, updatedAt: string, environmentScoped = false) =>
  Schema.decodeSync(Release)({
    id: RELEASE_ID,
    workspaceId: WORKSPACE_ID,
    serviceName: "payments-api",
    version,
    lifecycle: "candidate",
    relay: deriveReleaseRelay(RELEASE_ID),
    targetEnvironmentIds: [ENVIRONMENT_ID],
    roleAssignments: [
      {
        assignmentId: ASSIGNMENT_ID,
        actor: { _tag: "agent", agentId: AGENT_ID },
        role: environmentScoped ? "deployment-approver" : "release-approver",
        scope: environmentScoped
          ? {
            _tag: "environment",
            workspaceId: WORKSPACE_ID,
            releaseId: RELEASE_ID,
            environmentId: ENVIRONMENT_ID
          }
          : { _tag: "release", workspaceId: WORKSPACE_ID, releaseId: RELEASE_ID },
        lifecycle: { _tag: "active", assignedAt: updatedAt }
      }
    ],
    sourceRevisions: [],
    freshness: {
      _tag: "unavailable",
      pluginHealth: { _tag: "disabled", checkedAt: updatedAt },
      provenance: { _tag: "none", pluginConnectionId: PLUGIN_ID },
      sourceObservedAt: null,
      staleAfterSeconds: 300,
      synchronizedAt: null
    },
    createdAt: "2026-07-13T10:00:00.000Z",
    updatedAt
  })

const testConfig = Effect.gen(function*() {
  const fileSystem = yield* FileSystem.FileSystem
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "control-center-quarantine-" })
  return {
    blobRoot: `${root}/blobs`,
    busyTimeoutMilliseconds: 5_000,
    databaseUrl: `file:${root}/control-center.db`,
    maxConnections: 1
  }
})

const withReleaseRepositories = <Success, Failure>(
  use: Effect.Effect<
    Success,
    Failure,
    Database | PeopleRepository | QuarantineRepository | ReleaseRepository | WorkspaceRepository
  >
) =>
  Effect.gen(function*() {
    const config = yield* testConfig
    const database = databaseLayer(config)
    const foundation = QuarantineRepository.layer.pipe(Layer.provideMerge(database))
    const peopleLayer = PeopleRepository.layer.pipe(Layer.provide(foundation))
    const releaseLayer = ReleaseRepository.layer.pipe(Layer.provide(foundation))
    const workspaceLayer = WorkspaceRepository.layer.pipe(Layer.provide(foundation))
    return yield* use.pipe(
      Effect.provide(Layer.mergeAll(foundation, peopleLayer, releaseLayer, workspaceLayer))
    )
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped)

describe("quarantine", () => {
  it.effect("deduplicates repeated diagnostics and keeps order-independent observation bounds", () =>
    withReleaseRepositories(
      Effect.gen(function*() {
        const workspaces = yield* WorkspaceRepository
        const quarantine = yield* QuarantineRepository
        yield* workspaces.create(WORKSPACE_ID, {
          displayName: WorkspaceName.make("Payments"),
          createdAt: EARLIER
        })

        const diagnostic = Schema.decodeSync(DiagnosticFixture)({
          recordKind: "release-revision",
          recordKey: `${RELEASE_ID}:2`,
          schemaVersion: 1,
          payloadDigest: DIGEST,
          diagnosticCode: "schema-decode-failed",
          diagnosticSummary: "Stored release snapshot failed schema validation."
        })
        yield* quarantine.recordMalformed(WORKSPACE_ID, { ...diagnostic, observedAt: LATER })
        yield* quarantine.recordMalformed(WORKSPACE_ID, { ...diagnostic, observedAt: EARLIER })

        const records = yield* quarantine.list(WORKSPACE_ID)
        assert.lengthOf(records, 1)
        assert.strictEqual(records[0]?.occurrenceCount, 2)
        assert.deepStrictEqual(records[0]?.firstObservedAt, EARLIER)
        assert.deepStrictEqual(records[0]?.lastObservedAt, LATER)
      })
    ))

  it.effect("falls back to the newest valid release and quarantines only redacted tamper metadata", () =>
    withReleaseRepositories(
      Effect.gen(function*() {
        const database = yield* Database
        const workspaces = yield* WorkspaceRepository
        const releases = yield* ReleaseRepository
        const quarantine = yield* QuarantineRepository
        yield* workspaces.create(WORKSPACE_ID, {
          displayName: WorkspaceName.make("Payments"),
          createdAt: EARLIER
        })

        yield* releases.create(WORKSPACE_ID, release("2.18.0-rc.1", "2026-07-13T10:00:00.000Z"))
        yield* releases.append(
          WORKSPACE_ID,
          release("2.18.0-rc.2", "2026-07-13T10:05:00.000Z"),
          RecordRevision.make(1)
        )
        const changedCreatedAt = Schema.decodeSync(Release)({
          ...Schema.encodeSync(Release)(release("2.18.0-rc.3", "2026-07-13T10:06:00.000Z")),
          createdAt: "2026-07-13T09:59:00.000Z"
        })
        const immutableMismatch = yield* releases.append(
          WORKSPACE_ID,
          changedCreatedAt,
          RecordRevision.make(2)
        ).pipe(Effect.result)
        assert.isTrue(Result.isFailure(immutableMismatch))
        if (Result.isFailure(immutableMismatch)) {
          assert.instanceOf(immutableMismatch.failure, SourceIdentityMismatchError)
        }
        const stored = yield* database.sql<{ readonly snapshotDigest: string }>`SELECT
            snapshot_digest AS snapshotDigest
          FROM release_revisions
          WHERE workspace_id = ${WORKSPACE_ID}
            AND release_id = ${RELEASE_ID}
            AND revision = 2`
        const projections = yield* database.sql<{
          readonly assignmentCount: number
          readonly assignmentRevision: number
          readonly revisionCount: number
          readonly targetCount: number
        }>`SELECT
            (SELECT count(*) FROM role_assignments
              WHERE workspace_id = ${WORKSPACE_ID} AND release_id = ${RELEASE_ID}) AS assignmentCount,
            (SELECT revision FROM role_assignments
              WHERE workspace_id = ${WORKSPACE_ID} AND release_id = ${RELEASE_ID}) AS assignmentRevision,
            (SELECT count(*) FROM release_revisions
              WHERE workspace_id = ${WORKSPACE_ID} AND release_id = ${RELEASE_ID}) AS revisionCount,
            (SELECT count(*) FROM release_targets
              WHERE workspace_id = ${WORKSPACE_ID} AND release_id = ${RELEASE_ID}) AS targetCount`
        assert.deepStrictEqual(projections, [{
          assignmentCount: 1,
          assignmentRevision: 2,
          revisionCount: 2,
          targetCount: 1
        }])
        const secretCanary = "never-return-raw-release-payload"
        yield* database.sql`UPDATE release_revisions
          SET snapshot_json = ${`{"secret":"${secretCanary}"}`}
          WHERE workspace_id = ${WORKSPACE_ID}
            AND release_id = ${RELEASE_ID}
            AND revision = 2`

        const recovered = yield* releases.get(WORKSPACE_ID, RELEASE_ID)
        assert.strictEqual(recovered.revision, 1)
        assert.strictEqual(recovered.release.version, "2.18.0-rc.1")

        const records = yield* quarantine.list(WORKSPACE_ID)
        assert.lengthOf(records, 1)
        assert.strictEqual(records[0]?.diagnosticCode, "snapshot-digest-mismatch")
        assert.notStrictEqual(records[0]?.payloadDigest, stored[0]?.snapshotDigest)
        assert.notInclude(JSON.stringify(records), secretCanary)
      })
    ))

  it.effect("ignores and quarantines release revisions beyond the authoritative head", () =>
    withReleaseRepositories(
      Effect.gen(function*() {
        const database = yield* Database
        const quarantine = yield* QuarantineRepository
        const releases = yield* ReleaseRepository
        const workspaces = yield* WorkspaceRepository
        yield* workspaces.create(WORKSPACE_ID, {
          displayName: WorkspaceName.make("Payments"),
          createdAt: EARLIER
        })
        yield* releases.create(WORKSPACE_ID, release("2.18.0-rc.1", "2026-07-13T10:00:00.000Z"))
        yield* releases.append(
          WORKSPACE_ID,
          release("2.18.0-rc.2", "2026-07-13T10:05:00.000Z"),
          RecordRevision.make(1)
        )

        const secretCanary = "never-return-future-release-snapshot"
        yield* database.sql`INSERT INTO release_revisions (
          workspace_id, release_id, revision, snapshot_json, snapshot_digest, created_at
        ) VALUES (
          ${WORKSPACE_ID}, ${RELEASE_ID}, 99, ${`{"secret":"${secretCanary}"}`},
          ${"f".repeat(64)}, '2026-07-13T11:00:00.000Z'
        )`

        const recovered = yield* releases.get(WORKSPACE_ID, RELEASE_ID)
        const records = yield* quarantine.list(WORKSPACE_ID)

        assert.strictEqual(recovered.revision, 2)
        assert.strictEqual(recovered.release.version, "2.18.0-rc.2")
        assert.lengthOf(records, 1)
        assert.strictEqual(records[0]?.recordKey, `${RELEASE_ID}:99`)
        assert.strictEqual(records[0]?.diagnosticCode, "snapshot-beyond-head")
        assert.notInclude(JSON.stringify({ records, recovered }), secretCanary)
      })
    ))

  it.effect("falls back when the newest release revision envelope is malformed", () =>
    withReleaseRepositories(
      Effect.gen(function*() {
        const database = yield* Database
        const quarantine = yield* QuarantineRepository
        const releases = yield* ReleaseRepository
        const workspaces = yield* WorkspaceRepository
        yield* workspaces.create(WORKSPACE_ID, {
          displayName: WorkspaceName.make("Payments"),
          createdAt: EARLIER
        })
        yield* releases.create(WORKSPACE_ID, release("2.18.0-rc.1", "2026-07-13T10:00:00.000Z"))
        yield* releases.append(
          WORKSPACE_ID,
          release("2.18.0-rc.2", "2026-07-13T10:05:00.000Z"),
          RecordRevision.make(1)
        )

        const secretCanary = "never-return-malformed-release-envelope"
        yield* database.sql`UPDATE release_revisions
          SET created_at = ${secretCanary}
          WHERE workspace_id = ${WORKSPACE_ID}
            AND release_id = ${RELEASE_ID}
            AND revision = 2`

        const recovered = yield* releases.get(WORKSPACE_ID, RELEASE_ID)
        const records = yield* quarantine.list(WORKSPACE_ID)

        assert.strictEqual(recovered.revision, 1)
        assert.strictEqual(recovered.release.version, "2.18.0-rc.1")
        assert.lengthOf(records, 1)
        assert.strictEqual(records[0]?.recordKind, "release-revision")
        assert.strictEqual(records[0]?.recordKey, `${RELEASE_ID}:2`)
        assert.strictEqual(records[0]?.diagnosticCode, "release-revision-envelope-invalid")
        assert.notInclude(JSON.stringify({ records, recovered }), secretCanary)
      })
    ))

  it.effect("returns a typed failure and quarantines a malformed release head", () =>
    withReleaseRepositories(
      Effect.gen(function*() {
        const database = yield* Database
        const quarantine = yield* QuarantineRepository
        const releases = yield* ReleaseRepository
        const workspaces = yield* WorkspaceRepository
        yield* workspaces.create(WORKSPACE_ID, {
          displayName: WorkspaceName.make("Payments"),
          createdAt: EARLIER
        })
        yield* releases.create(WORKSPACE_ID, release("2.18.0-rc.1", "2026-07-13T10:00:00.000Z"))

        const secretCanary = "never-return-malformed-release-head"
        yield* database.sql`PRAGMA ignore_check_constraints = ON`
        yield* database.sql`UPDATE releases
          SET created_at = ${secretCanary}
          WHERE workspace_id = ${WORKSPACE_ID}
            AND release_id = ${RELEASE_ID}`
        yield* database.sql`PRAGMA ignore_check_constraints = OFF`

        const malformed = yield* releases.get(WORKSPACE_ID, RELEASE_ID).pipe(Effect.result)
        const records = yield* quarantine.list(WORKSPACE_ID)

        assert.isTrue(Result.isFailure(malformed))
        if (Result.isFailure(malformed)) {
          assert.instanceOf(malformed.failure, PersistedRecordError)
          assert.strictEqual(malformed.failure.diagnosticCode, "release-head-schema-invalid")
        }
        assert.lengthOf(records, 1)
        assert.strictEqual(records[0]?.recordKind, "release-head")
        assert.strictEqual(records[0]?.diagnosticCode, "release-head-schema-invalid")
        assert.notInclude(JSON.stringify({ malformed, records }), secretCanary)
      })
    ))

  it.effect("appends releases without deleting targets beneath environment roles", () =>
    withReleaseRepositories(
      Effect.gen(function*() {
        const database = yield* Database
        const workspaces = yield* WorkspaceRepository
        const releases = yield* ReleaseRepository
        yield* workspaces.create(WORKSPACE_ID, {
          displayName: WorkspaceName.make("Payments"),
          createdAt: EARLIER
        })

        yield* releases.create(
          WORKSPACE_ID,
          release("2.18.0-rc.1", "2026-07-13T10:00:00.000Z", true)
        )
        const appended = yield* releases.append(
          WORKSPACE_ID,
          release("2.18.0-rc.2", "2026-07-13T10:05:00.000Z", true),
          RecordRevision.make(1)
        )
        const projection = yield* database.sql<{
          readonly roleRevision: number
          readonly targetCount: number
        }>`SELECT
          (SELECT revision FROM role_assignments
            WHERE workspace_id = ${WORKSPACE_ID} AND assignment_id = ${ASSIGNMENT_ID}) AS roleRevision,
          (SELECT count(*) FROM release_targets
            WHERE workspace_id = ${WORKSPACE_ID} AND release_id = ${RELEASE_ID}) AS targetCount`

        assert.strictEqual(appended.revision, 2)
        assert.deepStrictEqual(projection, [{ roleRevision: 2, targetCount: 1 }])
      })
    ))

  it.effect("keeps release-owned roles behind release compare-and-swap", () =>
    withReleaseRepositories(
      Effect.gen(function*() {
        const database = yield* Database
        const people = yield* PeopleRepository
        const releases = yield* ReleaseRepository
        const workspaces = yield* WorkspaceRepository
        const initial = release("2.18.0-rc.1", "2026-07-13T10:00:00.000Z", true)
        yield* workspaces.create(WORKSPACE_ID, {
          displayName: WorkspaceName.make("Payments"),
          createdAt: EARLIER
        })
        yield* releases.create(WORKSPACE_ID, initial)
        const initialAssignment = initial.roleAssignments[0]
        if (initialAssignment === undefined) {
          return yield* Effect.die("release fixture requires one role assignment")
        }

        const independent = yield* people.updateRoleAssignment(
          WORKSPACE_ID,
          Schema.decodeSync(RoleAssignment)({
            ...Schema.encodeSync(RoleAssignment)(initialAssignment),
            role: "workspace-owner",
            scope: { _tag: "workspace", workspaceId: WORKSPACE_ID }
          }),
          RecordRevision.make(1),
          LATER
        ).pipe(Effect.result)

        assert.isTrue(Result.isFailure(independent))
        if (Result.isFailure(independent)) {
          assert.instanceOf(independent.failure, PersistenceOperationError)
          assert.strictEqual(independent.failure.operation, "people.release-owned-role.update")
        }

        const appended = yield* releases.append(
          WORKSPACE_ID,
          release("2.18.0-rc.2", "2026-07-13T11:00:00.000Z", true),
          RecordRevision.make(1)
        )
        const staleAppend = yield* releases.append(
          WORKSPACE_ID,
          release("2.18.0-rc.3", "2026-07-13T11:05:00.000Z", true),
          RecordRevision.make(1)
        ).pipe(Effect.result)
        const rows = yield* database.sql<{ readonly revision: number }>`SELECT revision
          FROM role_assignments
          WHERE workspace_id = ${WORKSPACE_ID}
            AND assignment_id = ${ASSIGNMENT_ID}`

        assert.strictEqual(appended.revision, 2)
        assert.deepStrictEqual(rows, [{ revision: 2 }])
        assert.isTrue(Result.isFailure(staleAppend))
        if (Result.isFailure(staleAppend)) {
          assert.instanceOf(staleAppend.failure, RevisionConflictError)
        }
      })
    ))
})
