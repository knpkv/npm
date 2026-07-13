import * as Context from "effect/Context"
import * as Crypto from "effect/Crypto"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import type { Success } from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as SqlSchema from "effect/unstable/sql/SqlSchema"

import { WorkspaceId } from "../../../domain/identifiers.js"
import { UtcTimestamp } from "../../../domain/utcTimestamp.js"
import { Database } from "../Database.js"
import { PersistedRecordError, RecordNotFoundError } from "../errors.js"
import {
  mapAlreadyExists,
  mapPersistenceOperation,
  readChanges,
  resolveCasFailure,
  revisionLookup
} from "./internal.js"
import { RecordRevision, WorkspaceName, WorkspaceRecord } from "./models.js"
import { makePersistedRowQuarantine } from "./persistedRowQuarantine.js"
import { QuarantineRepository } from "./quarantineRepository.js"

const CreateWorkspaceRequest = Schema.Struct({
  workspaceId: WorkspaceId,
  displayName: WorkspaceName,
  createdAt: UtcTimestamp
})

const UpdateWorkspaceRequest = Schema.Struct({
  workspaceId: WorkspaceId,
  displayName: WorkspaceName,
  expectedRevision: RecordRevision,
  updatedAt: UtcTimestamp
})

const makeWorkspaceRepository = Effect.gen(function*() {
  const cryptoService = yield* Crypto.Crypto
  const database = yield* Database
  const quarantine = yield* QuarantineRepository
  const quarantineRow = makePersistedRowQuarantine(cryptoService, quarantine)
  const sql = database.sql

  const findRows = ({ workspaceId }: { readonly workspaceId: WorkspaceId }) =>
    sql<Record<string, unknown>>`SELECT
      workspace_id AS workspaceId,
      display_name AS displayName,
      revision,
      created_at AS createdAt,
      updated_at AS updatedAt
    FROM workspaces
    WHERE workspace_id = ${workspaceId}`

  const get = Effect.fn("WorkspaceRepository.get")(function*(workspaceId: WorkspaceId) {
    const rows = yield* findRows({ workspaceId }).pipe(mapPersistenceOperation("workspace.get"))
    if (rows.length === 0) {
      return yield* new RecordNotFoundError({
        workspaceId,
        recordKind: "workspace",
        recordKey: workspaceId
      })
    }
    const decoded = Schema.decodeUnknownResult(WorkspaceRecord)(rows[0])
    if (Result.isSuccess(decoded)) return decoded.success
    const observedAt = yield* DateTime.now
    yield* quarantineRow({
      workspaceId,
      recordKind: "workspace",
      recordKey: workspaceId,
      diagnosticCode: "workspace-schema-invalid",
      diagnosticSummary: "Stored workspace failed schema validation.",
      observedAt,
      row: rows[0]
    })
    return yield* new PersistedRecordError({
      workspaceId,
      recordKind: "workspace",
      recordKey: workspaceId,
      diagnosticCode: "workspace-schema-invalid"
    })
  })

  const insert = SqlSchema.void({
    Request: CreateWorkspaceRequest,
    execute: ({ createdAt, displayName, workspaceId }) =>
      sql`INSERT INTO workspaces (
            workspace_id, display_name, revision, created_at, updated_at
          ) VALUES (${workspaceId}, ${displayName}, 1, ${createdAt}, ${createdAt})`
  })

  const update = SqlSchema.void({
    Request: UpdateWorkspaceRequest,
    execute: ({ displayName, expectedRevision, updatedAt, workspaceId }) =>
      sql`UPDATE workspaces
          SET display_name = ${displayName},
              revision = revision + 1,
              updated_at = ${updatedAt}
          WHERE workspace_id = ${workspaceId}
            AND revision = ${expectedRevision}`
  })

  return {
    create: Effect.fn("WorkspaceRepository.create")(function*(
      workspaceId: WorkspaceId,
      input: { readonly displayName: WorkspaceName; readonly createdAt: UtcTimestamp }
    ) {
      yield* insert({ workspaceId, ...input }).pipe(
        mapAlreadyExists({ workspaceId, recordKind: "workspace", recordKey: workspaceId }),
        mapPersistenceOperation("workspace.create")
      )
      return yield* get(workspaceId)
    }),
    get,
    updateDisplayName: Effect.fn("WorkspaceRepository.updateDisplayName")(function*(
      workspaceId: WorkspaceId,
      input: {
        readonly displayName: WorkspaceName
        readonly expectedRevision: RecordRevision
        readonly updatedAt: UtcTimestamp
      }
    ) {
      yield* database.transaction(
        Effect.gen(function*() {
          yield* update({ workspaceId, ...input })
          const changes = yield* readChanges(sql)
          if (changes === 0) {
            return yield* resolveCasFailure({
              workspaceId,
              recordKind: "workspace",
              recordKey: workspaceId,
              expectedRevision: input.expectedRevision,
              findActualRevision: revisionLookup(() =>
                sql`SELECT revision FROM workspaces WHERE workspace_id = ${workspaceId}`
              )
            })
          }
        })
      ).pipe(mapPersistenceOperation("workspace.update"))
      return yield* get(workspaceId)
    })
  }
})

/** Workspace-scoped persistence with optimistic-concurrency updates. */
export interface WorkspaceRepositoryService extends Success<typeof makeWorkspaceRepository> {}

/** Effect service for workspace records. */
export class WorkspaceRepository extends Context.Service<WorkspaceRepository, WorkspaceRepositoryService>()(
  "@knpkv/control-center/WorkspaceRepository"
) {
  /** Layer that binds SQL queries to the shared database at construction. */
  static readonly layer = Layer.effect(WorkspaceRepository, makeWorkspaceRepository)
}
