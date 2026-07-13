import * as Context from "effect/Context"
import * as Crypto from "effect/Crypto"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import type { Success } from "effect/Effect"
import * as Encoding from "effect/Encoding"
import * as Layer from "effect/Layer"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as SqlSchema from "effect/unstable/sql/SqlSchema"

import { Person, PersonAvatar, PersonSourceIdentity, Role, RoleAssignment } from "../../../domain/actors.js"
import {
  AgentId,
  EntityId,
  EnvironmentId,
  PersonId,
  ReleaseId,
  RoleAssignmentId,
  WorkspaceId
} from "../../../domain/identifiers.js"
import { UtcTimestamp } from "../../../domain/utcTimestamp.js"
import { Database } from "../Database.js"
import { PersistedRecordError, PersistenceOperationError, RecordNotFoundError } from "../errors.js"
import {
  mapAlreadyExists,
  mapPersistenceOperation,
  readChanges,
  resolveCasFailure,
  revisionLookup
} from "./internal.js"
import { ContentBlobDigest, PersonRecord, RecordRevision, RoleAssignmentRecord } from "./models.js"
import { makePersistedRowQuarantine } from "./persistedRowQuarantine.js"
import { QuarantineRepository } from "./quarantineRepository.js"

const PersonRow = Schema.Struct({
  workspaceId: WorkspaceId,
  personId: PersonId,
  displayName: Person.fields.displayName,
  avatarJson: Schema.String.check(Schema.isNonEmpty()),
  isActive: Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 0, maximum: 1 })),
  revision: RecordRevision,
  createdAt: UtcTimestamp,
  updatedAt: UtcTimestamp
})

const PersonIdentityRow = Schema.Struct({
  pluginConnectionId: PersonSourceIdentity.fields.pluginConnectionId,
  providerId: PersonSourceIdentity.fields.providerId,
  vendorPersonId: PersonSourceIdentity.fields.vendorPersonId
})

const RoleAssignmentRow = Schema.Struct({
  workspaceId: WorkspaceId,
  assignmentId: RoleAssignmentId,
  actorKind: Schema.Literals(["human", "agent"]),
  personId: Schema.Union([PersonId, Schema.Null]),
  agentId: Schema.Union([AgentId, Schema.Null]),
  role: Role,
  scopeKind: Schema.Literals(["workspace", "release", "environment", "entity"]),
  releaseId: Schema.Union([ReleaseId, Schema.Null]),
  environmentId: Schema.Union([EnvironmentId, Schema.Null]),
  entityId: Schema.Union([EntityId, Schema.Null]),
  lifecycleKind: Schema.Literals(["active", "ended", "revoked"]),
  assignedAt: UtcTimestamp,
  endedAt: Schema.Union([UtcTimestamp, Schema.Null]),
  revokedAt: Schema.Union([UtcTimestamp, Schema.Null]),
  revision: RecordRevision,
  createdAt: UtcTimestamp,
  updatedAt: UtcTimestamp
})

const RoleAssignmentIdentity = Schema.Struct({ assignmentId: RoleAssignmentId })
const RoleAssignmentOwnership = Schema.Struct({ scopeKind: RoleAssignmentRow.fields.scopeKind })

const avatarJson = Schema.fromJsonString(PersonAvatar)
const encodeAvatar = Schema.encodeEffect(avatarJson)
const decodeAvatar = Schema.decodeUnknownResult(avatarJson)

const decodeActor = (row: typeof RoleAssignmentRow.Type): unknown =>
  row.actorKind === "human"
    ? { _tag: "human", personId: row.personId }
    : { _tag: "agent", agentId: row.agentId }

const decodeScope = (row: typeof RoleAssignmentRow.Type): unknown => {
  switch (row.scopeKind) {
    case "workspace":
      return { _tag: "workspace", workspaceId: row.workspaceId }
    case "release":
      return { _tag: "release", workspaceId: row.workspaceId, releaseId: row.releaseId }
    case "environment":
      return {
        _tag: "environment",
        workspaceId: row.workspaceId,
        releaseId: row.releaseId,
        environmentId: row.environmentId
      }
    case "entity":
      return { _tag: "entity", workspaceId: row.workspaceId, entityId: row.entityId }
  }
}

const decodeLifecycle = (row: typeof RoleAssignmentRow.Type): unknown => {
  switch (row.lifecycleKind) {
    case "active":
      return { _tag: "active", assignedAt: row.assignedAt }
    case "ended":
      return { _tag: "ended", assignedAt: row.assignedAt, endedAt: row.endedAt }
    case "revoked":
      return { _tag: "revoked", assignedAt: row.assignedAt, revokedAt: row.revokedAt }
  }
}

const isReleaseOwnedScope = (scopeKind: typeof RoleAssignmentRow.Type["scopeKind"]): boolean =>
  scopeKind === "release" || scopeKind === "environment"

const releaseOwnedRoleError = (operation: "create" | "update") =>
  new PersistenceOperationError({ operation: `people.release-owned-role.${operation}` })

const decodeRoleAssignmentRecord = Effect.fn("PeopleRepository.decodeRoleAssignment")(function*(
  row: typeof RoleAssignmentRow.Type
) {
  const assignment = yield* Schema.decodeUnknownEffect(Schema.toType(RoleAssignment))({
    assignmentId: row.assignmentId,
    actor: decodeActor(row),
    role: row.role,
    scope: decodeScope(row),
    lifecycle: decodeLifecycle(row)
  })
  return yield* Schema.decodeUnknownEffect(Schema.toType(RoleAssignmentRecord))({
    workspaceId: row.workspaceId,
    assignment,
    revision: row.revision,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  })
})

const makePeopleRepository = Effect.gen(function*() {
  const cryptoService = yield* Crypto.Crypto
  const database = yield* Database
  const quarantine = yield* QuarantineRepository
  const quarantineRow = makePersistedRowQuarantine(cryptoService, quarantine)
  const sql = database.sql

  const digestPersistedText = Effect.fn("PeopleRepository.digestPersistedText")(function*(value: string) {
    const bytes = yield* Effect.fromResult(
      Encoding.decodeBase64(Encoding.encodeBase64(value))
    ).pipe(
      Effect.mapError(() => new PersistenceOperationError({ operation: "people.avatar-encode" }))
    )
    const digest = yield* cryptoService.digest("SHA-256", bytes).pipe(
      Effect.mapError(() => new PersistenceOperationError({ operation: "people.avatar-digest" }))
    )
    return ContentBlobDigest.make(Encoding.encodeHex(digest))
  })

  const decodePersistedAvatar = Effect.fn("PeopleRepository.decodePersistedAvatar")(function*(
    workspaceId: WorkspaceId,
    personId: PersonId,
    value: string,
    observedAt: UtcTimestamp
  ) {
    const decoded = decodeAvatar(value)
    if (decoded._tag === "Success") return decoded.success

    const payloadDigest = yield* digestPersistedText(value)
    yield* quarantine.recordMalformed(workspaceId, {
      recordKind: "person-avatar",
      recordKey: personId,
      schemaVersion: 1,
      payloadDigest,
      diagnosticCode: "schema-decode-failed",
      diagnosticSummary: "Stored person avatar failed schema validation.",
      observedAt
    })
    return yield* new PersistedRecordError({
      workspaceId,
      recordKind: "person-avatar",
      recordKey: personId,
      diagnosticCode: "schema-decode-failed"
    })
  })

  const findPersonRows = (
    { personId, workspaceId }: { readonly personId: PersonId; readonly workspaceId: WorkspaceId }
  ) =>
    sql<Record<string, unknown>>`SELECT
      workspace_id AS workspaceId,
      person_id AS personId,
      display_name AS displayName,
      avatar_json AS avatarJson,
      is_active AS isActive,
      revision,
      created_at AS createdAt,
      updated_at AS updatedAt
    FROM persons
    WHERE workspace_id = ${workspaceId}
      AND person_id = ${personId}`

  const findIdentityRows = (
    { personId, workspaceId }: { readonly personId: PersonId; readonly workspaceId: WorkspaceId }
  ) =>
    sql<Record<string, unknown>>`SELECT
      plugin_connection_id AS pluginConnectionId,
      provider_id AS providerId,
      vendor_person_id AS vendorPersonId
    FROM person_identities
    WHERE workspace_id = ${workspaceId}
      AND person_id = ${personId}
    ORDER BY provider_id, plugin_connection_id, vendor_person_id`

  const quarantineMalformedPerson = Effect.fn("PeopleRepository.quarantineMalformedPerson")(function*(
    workspaceId: WorkspaceId,
    personId: PersonId,
    row: unknown
  ) {
    const observedAt = yield* DateTime.now
    yield* quarantineRow({
      workspaceId,
      recordKind: "person",
      recordKey: personId,
      diagnosticCode: "person-schema-invalid",
      diagnosticSummary: "Stored person record failed schema validation.",
      observedAt,
      row
    })
  })

  const getPerson = Effect.fn("PeopleRepository.getPerson")(function*(
    workspaceId: WorkspaceId,
    personId: PersonId
  ) {
    const rows = yield* findPersonRows({ workspaceId, personId }).pipe(
      mapPersistenceOperation("people.get-person")
    )
    if (rows.length === 0) {
      return yield* new RecordNotFoundError({
        workspaceId,
        recordKind: "person",
        recordKey: personId
      })
    }
    const decodedRow = Schema.decodeUnknownResult(PersonRow)(rows[0])
    if (Result.isFailure(decodedRow)) {
      yield* quarantineMalformedPerson(workspaceId, personId, rows[0])
      return yield* new PersistedRecordError({
        workspaceId,
        recordKind: "person",
        recordKey: personId,
        diagnosticCode: "person-schema-invalid"
      })
    }
    const identityRows = yield* findIdentityRows({ workspaceId, personId }).pipe(
      mapPersistenceOperation("people.get-person-identities")
    )
    const identities: Array<typeof PersonIdentityRow.Type> = []
    for (const identityRow of identityRows) {
      const decodedIdentity = Schema.decodeUnknownResult(PersonIdentityRow)(identityRow)
      if (Result.isSuccess(decodedIdentity)) {
        identities.push(decodedIdentity.success)
      } else {
        const observedAt = yield* DateTime.now
        yield* quarantineRow({
          workspaceId,
          recordKind: "person-identity",
          recordKey: personId,
          diagnosticCode: "person-identity-schema-invalid",
          diagnosticSummary: "Stored person identity failed schema validation.",
          observedAt,
          row: identityRow
        })
      }
    }
    const avatar = yield* decodePersistedAvatar(
      workspaceId,
      personId,
      decodedRow.success.avatarJson,
      decodedRow.success.updatedAt
    )
    const decodedPerson = Schema.decodeUnknownResult(Schema.toType(Person))({
      personId,
      displayName: decodedRow.success.displayName,
      avatar,
      isActive: decodedRow.success.isActive === 1,
      sourceIdentities: identities
    })
    if (Result.isFailure(decodedPerson)) {
      yield* quarantineMalformedPerson(workspaceId, personId, {
        person: rows[0],
        identities: identityRows
      })
      return yield* new PersistedRecordError({
        workspaceId,
        recordKind: "person",
        recordKey: personId,
        diagnosticCode: "person-schema-invalid"
      })
    }
    return yield* Schema.decodeUnknownEffect(Schema.toType(PersonRecord))({
      workspaceId,
      person: decodedPerson.success,
      revision: decodedRow.success.revision,
      createdAt: decodedRow.success.createdAt,
      updatedAt: decodedRow.success.updatedAt
    })
  })

  const insertPerson = SqlSchema.void({
    Request: Schema.Struct({
      workspaceId: WorkspaceId,
      person: Person,
      avatarJson: Schema.String,
      createdAt: UtcTimestamp
    }),
    execute: ({ avatarJson, createdAt, person, workspaceId }) =>
      sql`INSERT INTO persons (
            workspace_id, person_id, display_name, avatar_json, is_active,
            revision, created_at, updated_at
          ) VALUES (
            ${workspaceId}, ${person.personId}, ${person.displayName}, ${avatarJson},
            ${person.isActive ? 1 : 0}, 1, ${createdAt}, ${createdAt}
          )`
  })

  const insertIdentity = SqlSchema.void({
    Request: Schema.Struct({
      workspaceId: WorkspaceId,
      personId: PersonId,
      identity: PersonSourceIdentity,
      createdAt: UtcTimestamp
    }),
    execute: ({ createdAt, identity, personId, workspaceId }) =>
      sql`INSERT INTO person_identities (
            workspace_id, person_id, plugin_connection_id, provider_id,
            vendor_person_id, created_at
          ) VALUES (
            ${workspaceId}, ${personId}, ${identity.pluginConnectionId}, ${identity.providerId},
            ${identity.vendorPersonId}, ${createdAt}
          )`
  })

  const replaceIdentities = Effect.fn("PeopleRepository.replaceIdentities")(function*(
    workspaceId: WorkspaceId,
    person: Person,
    createdAt: UtcTimestamp
  ) {
    yield* sql`DELETE FROM person_identities
      WHERE workspace_id = ${workspaceId}
        AND person_id = ${person.personId}`
    yield* Effect.forEach(
      person.sourceIdentities,
      (identity) => insertIdentity({ workspaceId, personId: person.personId, identity, createdAt }),
      { discard: true }
    )
  })

  const updatePerson = SqlSchema.void({
    Request: Schema.Struct({
      workspaceId: WorkspaceId,
      person: Person,
      avatarJson: Schema.String,
      expectedRevision: RecordRevision,
      updatedAt: UtcTimestamp
    }),
    execute: ({ avatarJson, expectedRevision, person, updatedAt, workspaceId }) =>
      sql`UPDATE persons
          SET display_name = ${person.displayName},
              avatar_json = ${avatarJson},
              is_active = ${person.isActive ? 1 : 0},
              revision = revision + 1,
              updated_at = ${updatedAt}
          WHERE workspace_id = ${workspaceId}
            AND person_id = ${person.personId}
            AND revision = ${expectedRevision}`
  })

  const assignmentColumns = sql`SELECT
    workspace_id AS workspaceId,
    assignment_id AS assignmentId,
    actor_kind AS actorKind,
    person_id AS personId,
    agent_id AS agentId,
    role,
    scope_kind AS scopeKind,
    release_id AS releaseId,
    environment_id AS environmentId,
    entity_id AS entityId,
    lifecycle_kind AS lifecycleKind,
    assigned_at AS assignedAt,
    ended_at AS endedAt,
    revoked_at AS revokedAt,
    revision,
    created_at AS createdAt,
    updated_at AS updatedAt
  FROM role_assignments`

  const findAssignmentRows = (
    { assignmentId, workspaceId }: {
      readonly assignmentId: RoleAssignmentId
      readonly workspaceId: WorkspaceId
    }
  ) =>
    sql<Record<string, unknown>>`${assignmentColumns}
      WHERE workspace_id = ${workspaceId}
        AND assignment_id = ${assignmentId}`

  const listAssignmentRows = (workspaceId: WorkspaceId) =>
    sql<Record<string, unknown>>`${assignmentColumns}
      WHERE workspace_id = ${workspaceId}
      ORDER BY updated_at DESC, assignment_id`

  const quarantineMalformedAssignment = Effect.fn(
    "PeopleRepository.quarantineMalformedAssignment"
  )(function*(workspaceId: WorkspaceId, row: unknown, fallbackKey: RoleAssignmentId | WorkspaceId) {
    const identity = Schema.decodeUnknownResult(RoleAssignmentIdentity)(row)
    const observedAt = yield* DateTime.now
    yield* quarantineRow({
      workspaceId,
      recordKind: "role-assignment",
      recordKey: Result.isSuccess(identity) ? identity.success.assignmentId : fallbackKey,
      diagnosticCode: "role-assignment-schema-invalid",
      diagnosticSummary: "Stored role assignment failed schema validation.",
      observedAt,
      row
    })
  })

  const assignmentValues = (assignment: RoleAssignment | typeof RoleAssignment.Encoded) => ({
    actorKind: assignment.actor._tag,
    personId: assignment.actor._tag === "human" ? assignment.actor.personId : null,
    agentId: assignment.actor._tag === "agent" ? assignment.actor.agentId : null,
    scopeKind: assignment.scope._tag,
    releaseId: assignment.scope._tag === "release" || assignment.scope._tag === "environment"
      ? assignment.scope.releaseId
      : null,
    environmentId: assignment.scope._tag === "environment" ? assignment.scope.environmentId : null,
    entityId: assignment.scope._tag === "entity" ? assignment.scope.entityId : null,
    lifecycleKind: assignment.lifecycle._tag,
    assignedAt: assignment.lifecycle.assignedAt,
    endedAt: assignment.lifecycle._tag === "ended" ? assignment.lifecycle.endedAt : null,
    revokedAt: assignment.lifecycle._tag === "revoked" ? assignment.lifecycle.revokedAt : null
  })

  const AssignmentWriteRequest = Schema.Struct({
    workspaceId: WorkspaceId,
    assignment: RoleAssignment,
    revision: RecordRevision,
    timestamp: UtcTimestamp
  })

  const insertAssignment = SqlSchema.void({
    Request: AssignmentWriteRequest,
    execute: ({ assignment, timestamp, workspaceId }) => {
      const values = assignmentValues(assignment)
      return sql`INSERT INTO role_assignments (
          workspace_id, assignment_id, actor_kind, person_id, agent_id, role,
          scope_kind, release_id, environment_id, entity_id, lifecycle_kind,
          assigned_at, ended_at, revoked_at, revision, created_at, updated_at
        ) VALUES (
          ${workspaceId}, ${assignment.assignmentId}, ${values.actorKind}, ${values.personId},
          ${values.agentId}, ${assignment.role}, ${values.scopeKind}, ${values.releaseId},
          ${values.environmentId}, ${values.entityId}, ${values.lifecycleKind},
          ${values.assignedAt}, ${values.endedAt}, ${values.revokedAt}, 1, ${timestamp}, ${timestamp}
        )`
    }
  })

  const updateAssignment = SqlSchema.void({
    Request: AssignmentWriteRequest,
    execute: ({ assignment, revision, timestamp, workspaceId }) => {
      const values = assignmentValues(assignment)
      return sql`UPDATE role_assignments SET
          actor_kind = ${values.actorKind}, person_id = ${values.personId}, agent_id = ${values.agentId},
          role = ${assignment.role}, scope_kind = ${values.scopeKind}, release_id = ${values.releaseId},
          environment_id = ${values.environmentId}, entity_id = ${values.entityId},
          lifecycle_kind = ${values.lifecycleKind}, assigned_at = ${values.assignedAt},
          ended_at = ${values.endedAt}, revoked_at = ${values.revokedAt},
          revision = revision + 1, updated_at = ${timestamp}
        WHERE workspace_id = ${workspaceId}
          AND assignment_id = ${assignment.assignmentId}
          AND revision = ${revision}
          AND scope_kind IN ('workspace', 'entity')`
    }
  })

  const getRoleAssignment = Effect.fn("PeopleRepository.getRoleAssignment")(function*(
    workspaceId: WorkspaceId,
    assignmentId: RoleAssignmentId
  ) {
    const rows = yield* findAssignmentRows({ workspaceId, assignmentId }).pipe(
      mapPersistenceOperation("people.get-role")
    )
    if (rows.length === 0) {
      return yield* new RecordNotFoundError({
        workspaceId,
        recordKind: "role-assignment",
        recordKey: assignmentId
      })
    }
    const decoded = Schema.decodeUnknownResult(RoleAssignmentRow)(rows[0])
    if (Result.isSuccess(decoded)) {
      const record = yield* decodeRoleAssignmentRecord(decoded.success).pipe(Effect.result)
      if (Result.isSuccess(record)) return record.success
    }
    yield* quarantineMalformedAssignment(workspaceId, rows[0], assignmentId)
    return yield* new PersistedRecordError({
      workspaceId,
      recordKind: "role-assignment",
      recordKey: assignmentId,
      diagnosticCode: "role-assignment-schema-invalid"
    })
  })

  return {
    createPerson: Effect.fn("PeopleRepository.createPerson")(function*(
      workspaceId: WorkspaceId,
      person: Person,
      createdAt: UtcTimestamp
    ) {
      const encodedAvatar = yield* encodeAvatar(person.avatar)
      yield* database.transaction(
        Effect.gen(function*() {
          yield* insertPerson({ workspaceId, person, avatarJson: encodedAvatar, createdAt })
          yield* replaceIdentities(workspaceId, person, createdAt)
        }).pipe(
          mapAlreadyExists({ workspaceId, recordKind: "person", recordKey: person.personId }),
          mapPersistenceOperation("people.create-person")
        )
      )
      return yield* getPerson(workspaceId, person.personId)
    }),
    getPerson,
    updatePerson: Effect.fn("PeopleRepository.updatePerson")(function*(
      workspaceId: WorkspaceId,
      person: Person,
      expectedRevision: RecordRevision,
      updatedAt: UtcTimestamp
    ) {
      const encodedAvatar = yield* encodeAvatar(person.avatar)
      yield* database.transaction(
        Effect.gen(function*() {
          yield* updatePerson({ workspaceId, person, avatarJson: encodedAvatar, expectedRevision, updatedAt })
          const changes = yield* readChanges(sql)
          if (changes === 0) {
            return yield* resolveCasFailure({
              workspaceId,
              recordKind: "person",
              recordKey: person.personId,
              expectedRevision,
              findActualRevision: revisionLookup(() =>
                sql`SELECT revision FROM persons
                    WHERE workspace_id = ${workspaceId} AND person_id = ${person.personId}`
              )
            })
          }
          yield* replaceIdentities(workspaceId, person, updatedAt)
        }).pipe(mapPersistenceOperation("people.update-person"))
      )
      return yield* getPerson(workspaceId, person.personId)
    }),
    createRoleAssignment: Effect.fn("PeopleRepository.createRoleAssignment")(function*(
      workspaceId: WorkspaceId,
      assignment: RoleAssignment,
      createdAt: UtcTimestamp
    ) {
      if (isReleaseOwnedScope(assignment.scope._tag)) {
        return yield* releaseOwnedRoleError("create")
      }
      if (assignment.scope.workspaceId !== workspaceId) {
        return yield* new RecordNotFoundError({
          workspaceId,
          recordKind: "role-assignment",
          recordKey: assignment.assignmentId
        })
      }
      yield* insertAssignment({
        workspaceId,
        assignment,
        revision: RecordRevision.make(1),
        timestamp: createdAt
      }).pipe(
        mapAlreadyExists({
          workspaceId,
          recordKind: "role-assignment",
          recordKey: assignment.assignmentId
        }),
        mapPersistenceOperation("people.create-role")
      )
      return yield* getRoleAssignment(workspaceId, assignment.assignmentId)
    }),
    getRoleAssignment,
    listRoleAssignments: Effect.fn("PeopleRepository.listRoleAssignments")(function*(
      workspaceId: WorkspaceId
    ) {
      const rows = yield* listAssignmentRows(workspaceId).pipe(
        mapPersistenceOperation("people.list-roles")
      )
      const assignments: Array<RoleAssignmentRecord> = []
      for (const row of rows) {
        const decoded = Schema.decodeUnknownResult(RoleAssignmentRow)(row)
        if (Result.isSuccess(decoded)) {
          const record = yield* decodeRoleAssignmentRecord(decoded.success).pipe(Effect.result)
          if (Result.isSuccess(record)) {
            assignments.push(record.success)
            continue
          }
        }
        yield* quarantineMalformedAssignment(workspaceId, row, workspaceId)
      }
      return assignments
    }),
    updateRoleAssignment: Effect.fn("PeopleRepository.updateRoleAssignment")(function*(
      workspaceId: WorkspaceId,
      assignment: RoleAssignment,
      expectedRevision: RecordRevision,
      updatedAt: UtcTimestamp
    ) {
      if (isReleaseOwnedScope(assignment.scope._tag)) {
        return yield* releaseOwnedRoleError("update")
      }
      if (assignment.scope.workspaceId !== workspaceId) {
        return yield* new RecordNotFoundError({
          workspaceId,
          recordKind: "role-assignment",
          recordKey: assignment.assignmentId
        })
      }
      yield* database.transaction(
        Effect.gen(function*() {
          yield* updateAssignment({ workspaceId, assignment, revision: expectedRevision, timestamp: updatedAt })
          const changes = yield* readChanges(sql)
          if (changes === 0) {
            const existing = yield* sql<Record<string, unknown>>`SELECT scope_kind AS scopeKind
              FROM role_assignments
              WHERE workspace_id = ${workspaceId}
                AND assignment_id = ${assignment.assignmentId}`
            const ownership = Schema.decodeUnknownResult(RoleAssignmentOwnership)(existing[0])
            if (Result.isSuccess(ownership) && isReleaseOwnedScope(ownership.success.scopeKind)) {
              return yield* releaseOwnedRoleError("update")
            }
            return yield* resolveCasFailure({
              workspaceId,
              recordKind: "role-assignment",
              recordKey: assignment.assignmentId,
              expectedRevision,
              findActualRevision: revisionLookup(() =>
                sql`SELECT revision FROM role_assignments
                    WHERE workspace_id = ${workspaceId}
                      AND assignment_id = ${assignment.assignmentId}`
              )
            })
          }
        }).pipe(mapPersistenceOperation("people.update-role"))
      )
      return yield* getRoleAssignment(workspaceId, assignment.assignmentId)
    })
  }
})

/** Workspace-scoped canonical people, identities, and collaborator roles. */
export interface PeopleRepositoryService extends Success<typeof makePeopleRepository> {}

/** Effect service for human-centric collaborator persistence. */
export class PeopleRepository extends Context.Service<PeopleRepository, PeopleRepositoryService>()(
  "@knpkv/control-center/PeopleRepository"
) {
  /** Layer that binds SQL queries to the shared database at construction. */
  static readonly layer = Layer.effect(PeopleRepository, makePeopleRepository)
}
