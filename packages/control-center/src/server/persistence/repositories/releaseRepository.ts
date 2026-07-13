import * as Context from "effect/Context"
import * as Crypto from "effect/Crypto"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import type { Success } from "effect/Effect"
import * as Encoding from "effect/Encoding"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as SqlSchema from "effect/unstable/sql/SqlSchema"

import { RoleAssignment } from "../../../domain/actors.js"
import { EnvironmentId, ReleaseId, WorkspaceId } from "../../../domain/identifiers.js"
import { Release } from "../../../domain/release.js"
import { UtcTimestamp } from "../../../domain/utcTimestamp.js"
import { Database } from "../Database.js"
import {
  PersistedRecordError,
  PersistenceOperationError,
  RecordNotFoundError,
  SourceIdentityMismatchError
} from "../errors.js"
import {
  mapAlreadyExists,
  mapPersistenceOperation,
  readChanges,
  resolveCasFailure,
  revisionLookup
} from "./internal.js"
import {
  ContentBlobDigest,
  type QuarantineDiagnosticSummary,
  type QuarantineReasonCode,
  RecordRevision,
  ReleaseSnapshotRecord
} from "./models.js"
import { makePersistedRowQuarantine } from "./persistedRowQuarantine.js"
import { QuarantineRepository } from "./quarantineRepository.js"

const RELEASE_SCHEMA_VERSION = 1

const ReleaseKey = Schema.Struct({ workspaceId: WorkspaceId, releaseId: ReleaseId })

const ReleaseRevisionRow = Schema.Struct({
  revision: RecordRevision,
  snapshotJson: Schema.String.check(Schema.isNonEmpty()),
  snapshotDigest: ContentBlobDigest,
  createdAt: UtcTimestamp
})

const ReleaseRevisionIdentity = Schema.Struct({ revision: RecordRevision })

const CreateReleaseRequest = Schema.Struct({
  ...ReleaseKey.fields,
  snapshotJson: Schema.String.check(Schema.isNonEmpty()),
  snapshotDigest: ContentBlobDigest,
  createdAt: UtcTimestamp,
  updatedAt: UtcTimestamp
})

const AppendReleaseRequest = Schema.Struct({
  ...CreateReleaseRequest.fields,
  expectedRevision: RecordRevision
})

const releaseJson = Schema.fromJsonString(Release)
const encodeRelease = Schema.encodeEffect(releaseJson)
const decodeRelease = Schema.decodeUnknownResult(releaseJson)

const encodeDigest = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")

const makeReleaseRepository = Effect.gen(function*() {
  const database = yield* Database
  const cryptoService = yield* Crypto.Crypto
  const quarantine = yield* QuarantineRepository
  const quarantineRow = makePersistedRowQuarantine(cryptoService, quarantine)
  const sql = database.sql

  const digestSnapshot = Effect.fn("ReleaseRepository.digestSnapshot")(function*(snapshotJson: string) {
    const bytes = yield* Effect.fromResult(
      Encoding.decodeBase64(Encoding.encodeBase64(snapshotJson))
    ).pipe(
      Effect.mapError(() => new PersistenceOperationError({ operation: "release.encode-utf8" }))
    )
    const digest = yield* cryptoService.digest("SHA-256", bytes).pipe(
      Effect.mapError(() => new PersistenceOperationError({ operation: "release.digest" }))
    )
    return ContentBlobDigest.make(encodeDigest(digest))
  })

  const prepareSnapshot = Effect.fn("ReleaseRepository.prepareSnapshot")(function*(release: Release) {
    const snapshotJson = yield* encodeRelease(release).pipe(
      Effect.mapError(() => new PersistenceOperationError({ operation: "release.encode" }))
    )
    const snapshotDigest = yield* digestSnapshot(snapshotJson)
    return { snapshotJson, snapshotDigest }
  })

  const insertHead = SqlSchema.void({
    Request: CreateReleaseRequest,
    execute: ({ createdAt, releaseId, updatedAt, workspaceId }) =>
      sql`INSERT INTO releases (
            workspace_id, release_id, current_revision, created_at, updated_at
          ) VALUES (${workspaceId}, ${releaseId}, 1, ${createdAt}, ${updatedAt})`
  })

  const insertRevision = SqlSchema.void({
    Request: Schema.Struct({
      ...CreateReleaseRequest.fields,
      revision: RecordRevision
    }),
    execute: ({ releaseId, revision, snapshotDigest, snapshotJson, updatedAt, workspaceId }) =>
      sql`INSERT INTO release_revisions (
            workspace_id, release_id, revision, snapshot_json, snapshot_digest, created_at
          ) VALUES (
            ${workspaceId}, ${releaseId}, ${revision}, ${snapshotJson}, ${snapshotDigest}, ${updatedAt}
          )`
  })

  const insertTarget = SqlSchema.void({
    Request: Schema.Struct({
      ...ReleaseKey.fields,
      environmentId: EnvironmentId,
      createdAt: UtcTimestamp
    }),
    execute: ({ createdAt, environmentId, releaseId, workspaceId }) =>
      sql`INSERT INTO release_targets (
            workspace_id, release_id, environment_id, created_at
          ) VALUES (${workspaceId}, ${releaseId}, ${environmentId}, ${createdAt})
          ON CONFLICT (workspace_id, release_id, environment_id) DO NOTHING`
  })

  const replaceTargets = Effect.fn("ReleaseRepository.replaceTargets")(function*(
    workspaceId: WorkspaceId,
    release: Release
  ) {
    yield* Effect.forEach(
      release.targetEnvironmentIds,
      (environmentId) =>
        insertTarget({
          workspaceId,
          releaseId: release.id,
          environmentId,
          createdAt: release.updatedAt
        }),
      { discard: true }
    )
  })

  const TargetHead = Schema.Struct({ environmentId: EnvironmentId })

  const listTargetHeads = SqlSchema.findAll({
    Request: ReleaseKey,
    Result: TargetHead,
    execute: ({ releaseId, workspaceId }) =>
      sql`SELECT environment_id AS environmentId
          FROM release_targets
          WHERE workspace_id = ${workspaceId}
            AND release_id = ${releaseId}`
  })

  const deleteObsoleteTargets = Effect.fn("ReleaseRepository.deleteObsoleteTargets")(function*(
    workspaceId: WorkspaceId,
    release: Release
  ) {
    const desired = new Set(release.targetEnvironmentIds)
    const existing = yield* listTargetHeads({ workspaceId, releaseId: release.id })
    yield* Effect.forEach(
      existing.filter(({ environmentId }) => !desired.has(environmentId)),
      ({ environmentId }) =>
        sql`DELETE FROM release_targets
            WHERE workspace_id = ${workspaceId}
              AND release_id = ${release.id}
              AND environment_id = ${environmentId}`,
      { discard: true }
    )
  })

  const insertProjectedAssignment = SqlSchema.void({
    Request: Schema.Struct({
      workspaceId: WorkspaceId,
      assignment: RoleAssignment,
      timestamp: UtcTimestamp
    }),
    execute: ({ assignment, timestamp, workspaceId }) => {
      const personId = assignment.actor._tag === "human" ? assignment.actor.personId : null
      const agentId = assignment.actor._tag === "agent" ? assignment.actor.agentId : null
      const releaseId = assignment.scope._tag === "release" || assignment.scope._tag === "environment"
        ? assignment.scope.releaseId
        : null
      const environmentId = assignment.scope._tag === "environment" ? assignment.scope.environmentId : null
      const entityId = assignment.scope._tag === "entity" ? assignment.scope.entityId : null
      const endedAt = assignment.lifecycle._tag === "ended" ? assignment.lifecycle.endedAt : null
      const revokedAt = assignment.lifecycle._tag === "revoked" ? assignment.lifecycle.revokedAt : null
      return sql`INSERT INTO role_assignments (
            workspace_id, assignment_id, actor_kind, person_id, agent_id, role,
            scope_kind, release_id, environment_id, entity_id, lifecycle_kind,
            assigned_at, ended_at, revoked_at, revision, created_at, updated_at
          ) VALUES (
            ${workspaceId}, ${assignment.assignmentId}, ${assignment.actor._tag}, ${personId},
            ${agentId}, ${assignment.role}, ${assignment.scope._tag}, ${releaseId},
            ${environmentId}, ${entityId}, ${assignment.lifecycle._tag},
            ${assignment.lifecycle.assignedAt}, ${endedAt}, ${revokedAt}, 1, ${timestamp}, ${timestamp}
          )
          ON CONFLICT (workspace_id, assignment_id) DO UPDATE SET
            actor_kind = excluded.actor_kind,
            person_id = excluded.person_id,
            agent_id = excluded.agent_id,
            role = excluded.role,
            scope_kind = excluded.scope_kind,
            release_id = excluded.release_id,
            environment_id = excluded.environment_id,
            entity_id = excluded.entity_id,
            lifecycle_kind = excluded.lifecycle_kind,
            assigned_at = excluded.assigned_at,
            ended_at = excluded.ended_at,
            revoked_at = excluded.revoked_at,
            revision = role_assignments.revision + 1,
            updated_at = excluded.updated_at`
    }
  })

  const ProjectionHead = Schema.Struct({
    assignmentId: RoleAssignment.fields.assignmentId,
    releaseId: Schema.Union([ReleaseId, Schema.Null]),
    revision: RecordRevision
  })

  const listProjectionHeads = SqlSchema.findAll({
    Request: ReleaseKey,
    Result: ProjectionHead,
    execute: ({ releaseId, workspaceId }) =>
      sql`SELECT
            assignment_id AS assignmentId,
            release_id AS releaseId,
            revision
          FROM role_assignments
          WHERE workspace_id = ${workspaceId}
            AND release_id = ${releaseId}`
  })

  const findProjectionHead = SqlSchema.findOneOption({
    Request: Schema.Struct({
      workspaceId: WorkspaceId,
      assignmentId: RoleAssignment.fields.assignmentId
    }),
    Result: ProjectionHead,
    execute: ({ assignmentId, workspaceId }) =>
      sql`SELECT
            assignment_id AS assignmentId,
            release_id AS releaseId,
            revision
          FROM role_assignments
          WHERE workspace_id = ${workspaceId}
            AND assignment_id = ${assignmentId}`
  })

  const replaceRoleAssignments = Effect.fn("ReleaseRepository.replaceRoleAssignments")(function*(
    workspaceId: WorkspaceId,
    release: Release
  ) {
    const projected = release.roleAssignments.filter(
      ({ scope }) => scope._tag === "release" || scope._tag === "environment"
    )
    const desiredIds = new Set(projected.map(({ assignmentId }) => assignmentId))
    const existing = yield* listProjectionHeads({ workspaceId, releaseId: release.id })
    yield* Effect.forEach(
      existing.filter(({ assignmentId }) => !desiredIds.has(assignmentId)),
      ({ assignmentId }) =>
        sql`DELETE FROM role_assignments
            WHERE workspace_id = ${workspaceId}
              AND assignment_id = ${assignmentId}`,
      { discard: true }
    )
    yield* Effect.forEach(
      projected,
      (assignment) =>
        Effect.gen(function*() {
          const head = yield* findProjectionHead({ workspaceId, assignmentId: assignment.assignmentId })
          if (Option.isSome(head) && head.value.releaseId !== release.id) {
            return yield* new SourceIdentityMismatchError({
              workspaceId,
              recordKind: "role-assignment",
              recordKey: assignment.assignmentId
            })
          }
          yield* insertProjectedAssignment({ workspaceId, assignment, timestamp: release.updatedAt })
        }),
      { discard: true }
    )
  })

  const updateHead = SqlSchema.void({
    Request: AppendReleaseRequest,
    execute: ({ expectedRevision, releaseId, updatedAt, workspaceId }) =>
      sql`UPDATE releases
          SET current_revision = current_revision + 1,
              updated_at = ${updatedAt}
          WHERE workspace_id = ${workspaceId}
            AND release_id = ${releaseId}
            AND current_revision = ${expectedRevision}`
  })

  const ReleaseHead = Schema.Struct({
    revision: RecordRevision,
    createdAt: UtcTimestamp
  })

  const findReleaseHead = SqlSchema.findOneOption({
    Request: ReleaseKey,
    Result: ReleaseHead,
    execute: ({ releaseId, workspaceId }) =>
      sql`SELECT current_revision AS revision, created_at AS createdAt
          FROM releases
          WHERE workspace_id = ${workspaceId}
            AND release_id = ${releaseId}`
  })

  const findReleaseHeadRows = ({ releaseId, workspaceId }: typeof ReleaseKey.Type) =>
    sql<Record<string, unknown>>`SELECT current_revision AS revision, created_at AS createdAt
      FROM releases
      WHERE workspace_id = ${workspaceId}
        AND release_id = ${releaseId}`

  const findRevisionRows = ({ releaseId, workspaceId }: typeof ReleaseKey.Type) =>
    sql<Record<string, unknown>>`SELECT
      revision,
      snapshot_json AS snapshotJson,
      snapshot_digest AS snapshotDigest,
      created_at AS createdAt
    FROM release_revisions
    WHERE workspace_id = ${workspaceId}
      AND release_id = ${releaseId}
    ORDER BY revision DESC`

  const quarantineMalformed = Effect.fn("ReleaseRepository.quarantineMalformed")(function*(
    workspaceId: WorkspaceId,
    releaseId: ReleaseId,
    row: typeof ReleaseRevisionRow.Type,
    diagnosticCode: QuarantineReasonCode,
    diagnosticSummary: QuarantineDiagnosticSummary,
    observedAt: UtcTimestamp,
    payloadDigest: ContentBlobDigest = row.snapshotDigest
  ) {
    yield* quarantine.recordMalformed(workspaceId, {
      recordKind: "release-revision",
      recordKey: `${releaseId}:${row.revision}`,
      schemaVersion: RELEASE_SCHEMA_VERSION,
      payloadDigest,
      diagnosticCode,
      diagnosticSummary,
      observedAt
    })
  })

  const decodeLatestValid = Effect.fn("ReleaseRepository.decodeLatestValid")(function*(
    workspaceId: WorkspaceId,
    releaseId: ReleaseId,
    rows: ReadonlyArray<typeof ReleaseRevisionRow.Type>
  ) {
    const observedAt = yield* DateTime.now
    for (const row of rows) {
      const actualDigest = yield* digestSnapshot(row.snapshotJson)
      if (actualDigest !== row.snapshotDigest) {
        yield* quarantineMalformed(
          workspaceId,
          releaseId,
          row,
          "snapshot-digest-mismatch",
          "Stored release snapshot digest does not match its content.",
          observedAt,
          actualDigest
        )
        continue
      }

      const decoded = decodeRelease(row.snapshotJson)
      if (Result.isFailure(decoded)) {
        yield* quarantineMalformed(
          workspaceId,
          releaseId,
          row,
          "schema-decode-failed",
          "Stored release snapshot does not satisfy the current release schema.",
          observedAt
        )
        continue
      }
      if (decoded.success.workspaceId !== workspaceId || decoded.success.id !== releaseId) {
        yield* quarantineMalformed(
          workspaceId,
          releaseId,
          row,
          "snapshot-identity-mismatch",
          "Stored release snapshot identity does not match its repository key.",
          observedAt
        )
        continue
      }
      return yield* Schema.decodeUnknownEffect(Schema.toType(ReleaseSnapshotRecord))({
        release: decoded.success,
        revision: row.revision
      })
    }

    return yield* new PersistedRecordError({
      workspaceId,
      recordKind: "release",
      recordKey: releaseId,
      diagnosticCode: "no-valid-snapshot"
    })
  })

  const get = Effect.fn("ReleaseRepository.get")(function*(
    workspaceId: WorkspaceId,
    releaseId: ReleaseId
  ) {
    const headRows = yield* findReleaseHeadRows({ workspaceId, releaseId })
    if (headRows.length === 0) {
      return yield* new RecordNotFoundError({
        workspaceId,
        recordKind: "release",
        recordKey: releaseId
      })
    }
    const head = Schema.decodeUnknownResult(ReleaseHead)(headRows[0])
    if (Result.isFailure(head)) {
      const observedAt = yield* DateTime.now
      yield* quarantineRow({
        workspaceId,
        recordKind: "release-head",
        recordKey: releaseId,
        diagnosticCode: "release-head-schema-invalid",
        diagnosticSummary: "Stored release head failed schema validation.",
        observedAt,
        row: headRows[0]
      })
      return yield* new PersistedRecordError({
        workspaceId,
        recordKind: "release",
        recordKey: releaseId,
        diagnosticCode: "release-head-schema-invalid"
      })
    }
    const rawRows = yield* findRevisionRows({ workspaceId, releaseId })
    const rows: Array<typeof ReleaseRevisionRow.Type> = []
    for (const rawRow of rawRows) {
      const identity = Schema.decodeUnknownResult(ReleaseRevisionIdentity)(rawRow)
      const recordKey = Result.isSuccess(identity)
        ? `${releaseId}:${identity.success.revision}`
        : releaseId
      if (Result.isSuccess(identity) && identity.success.revision > head.success.revision) {
        const observedAt = yield* DateTime.now
        yield* quarantineRow({
          workspaceId,
          recordKind: "release-revision",
          recordKey,
          diagnosticCode: "snapshot-beyond-head",
          diagnosticSummary: "Stored release snapshot exceeds its authoritative head.",
          observedAt,
          row: rawRow
        })
        continue
      }
      const decoded = Schema.decodeUnknownResult(ReleaseRevisionRow)(rawRow)
      if (Result.isFailure(decoded)) {
        const observedAt = yield* DateTime.now
        yield* quarantineRow({
          workspaceId,
          recordKind: "release-revision",
          recordKey,
          diagnosticCode: "release-revision-envelope-invalid",
          diagnosticSummary: "Stored release revision envelope failed schema validation.",
          observedAt,
          row: rawRow
        })
        continue
      }
      rows.push(decoded.success)
    }
    return yield* decodeLatestValid(workspaceId, releaseId, rows)
  })

  const ensureWorkspace = Effect.fn("ReleaseRepository.ensureWorkspace")(function*(
    workspaceId: WorkspaceId,
    release: Release
  ) {
    if (release.workspaceId !== workspaceId) {
      return yield* new RecordNotFoundError({
        workspaceId,
        recordKind: "release",
        recordKey: release.id
      })
    }
  })

  return {
    create: Effect.fn("ReleaseRepository.create")(function*(workspaceId: WorkspaceId, release: Release) {
      yield* ensureWorkspace(workspaceId, release)
      const snapshot = yield* prepareSnapshot(release)
      yield* database.transaction(
        Effect.gen(function*() {
          yield* insertHead({
            workspaceId,
            releaseId: release.id,
            ...snapshot,
            createdAt: release.createdAt,
            updatedAt: release.updatedAt
          })
          yield* insertRevision({
            workspaceId,
            releaseId: release.id,
            ...snapshot,
            createdAt: release.createdAt,
            updatedAt: release.updatedAt,
            revision: RecordRevision.make(1)
          })
          yield* replaceTargets(workspaceId, release)
          yield* replaceRoleAssignments(workspaceId, release)
          yield* deleteObsoleteTargets(workspaceId, release)
        }).pipe(
          mapAlreadyExists({ workspaceId, recordKind: "release", recordKey: release.id }),
          mapPersistenceOperation("release.create")
        )
      )
      return yield* get(workspaceId, release.id)
    }),
    get: (workspaceId: WorkspaceId, releaseId: ReleaseId) =>
      get(workspaceId, releaseId).pipe(mapPersistenceOperation("release.get")),
    append: Effect.fn("ReleaseRepository.append")(function*(
      workspaceId: WorkspaceId,
      release: Release,
      expectedRevision: RecordRevision
    ) {
      yield* ensureWorkspace(workspaceId, release)
      const snapshot = yield* prepareSnapshot(release)
      yield* database.transaction(
        Effect.gen(function*() {
          const head = yield* findReleaseHead({ workspaceId, releaseId: release.id })
          if (Option.isNone(head)) {
            return yield* new RecordNotFoundError({
              workspaceId,
              recordKind: "release",
              recordKey: release.id
            })
          }
          if (!DateTime.Equivalence(head.value.createdAt, release.createdAt)) {
            return yield* new SourceIdentityMismatchError({
              workspaceId,
              recordKind: "release",
              recordKey: release.id
            })
          }
          yield* updateHead({
            workspaceId,
            releaseId: release.id,
            ...snapshot,
            createdAt: release.createdAt,
            updatedAt: release.updatedAt,
            expectedRevision
          })
          const changes = yield* readChanges(sql)
          if (changes === 0) {
            return yield* resolveCasFailure({
              workspaceId,
              recordKind: "release",
              recordKey: release.id,
              expectedRevision,
              findActualRevision: revisionLookup(() =>
                sql`SELECT current_revision AS revision
                    FROM releases
                    WHERE workspace_id = ${workspaceId}
                      AND release_id = ${release.id}`
              )
            })
          }
          yield* insertRevision({
            workspaceId,
            releaseId: release.id,
            ...snapshot,
            createdAt: release.createdAt,
            updatedAt: release.updatedAt,
            revision: RecordRevision.make(expectedRevision + 1)
          })
          yield* replaceTargets(workspaceId, release)
          yield* replaceRoleAssignments(workspaceId, release)
          yield* deleteObsoleteTargets(workspaceId, release)
        }).pipe(mapPersistenceOperation("release.append"))
      )
      return yield* get(workspaceId, release.id)
    })
  }
})

/** Immutable release snapshots with CAS heads and quarantined fallback reads. */
export interface ReleaseRepositoryService extends Success<typeof makeReleaseRepository> {}

/** Effect service for release aggregate persistence. */
export class ReleaseRepository extends Context.Service<ReleaseRepository, ReleaseRepositoryService>()(
  "@knpkv/control-center/ReleaseRepository"
) {
  /** Layer that captures database, cryptography, and quarantine dependencies. */
  static readonly layer = Layer.effect(ReleaseRepository, makeReleaseRepository)
}
