import * as Context from "effect/Context"
import * as Crypto from "effect/Crypto"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import type { Success } from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as SqlSchema from "effect/unstable/sql/SqlSchema"

import { PluginConnectionId, WorkspaceId } from "../../../domain/identifiers.js"
import { ProviderId } from "../../../domain/sourceRevision.js"
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
import { PluginConnectionDisplayName, PluginConnectionRecord, RecordRevision } from "./models.js"
import { makePersistedRowQuarantine } from "./persistedRowQuarantine.js"
import { QuarantineRepository } from "./quarantineRepository.js"

const PluginConnectionRow = Schema.Struct({
  workspaceId: WorkspaceId,
  pluginConnectionId: PluginConnectionId,
  providerId: ProviderId,
  displayName: PluginConnectionDisplayName,
  isEnabled: Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 0, maximum: 1 })),
  revision: RecordRevision,
  createdAt: UtcTimestamp,
  updatedAt: UtcTimestamp
})

const PluginConnectionKey = Schema.Struct({
  workspaceId: WorkspaceId,
  pluginConnectionId: PluginConnectionId
})

const PluginConnectionIdentity = Schema.Struct({ pluginConnectionId: PluginConnectionId })

const CreatePluginConnectionRequest = Schema.Struct({
  ...PluginConnectionKey.fields,
  providerId: ProviderId,
  displayName: PluginConnectionDisplayName,
  isEnabled: Schema.Boolean,
  createdAt: UtcTimestamp
})

const UpdatePluginConnectionRequest = Schema.Struct({
  ...PluginConnectionKey.fields,
  displayName: PluginConnectionDisplayName,
  isEnabled: Schema.Boolean,
  expectedRevision: RecordRevision,
  updatedAt: UtcTimestamp
})

const decodeRecord = Effect.fn("PluginConnectionRepository.decodeRecord")(function*(
  row: typeof PluginConnectionRow.Type
) {
  return yield* Schema.decodeUnknownEffect(Schema.toType(PluginConnectionRecord))({
    ...row,
    isEnabled: row.isEnabled === 1
  })
})

const makePluginConnectionRepository = Effect.gen(function*() {
  const cryptoService = yield* Crypto.Crypto
  const database = yield* Database
  const quarantine = yield* QuarantineRepository
  const quarantineRow = makePersistedRowQuarantine(cryptoService, quarantine)
  const sql = database.sql

  const selectColumns = sql`SELECT
    workspace_id AS workspaceId,
    plugin_connection_id AS pluginConnectionId,
    provider_id AS providerId,
    display_name AS displayName,
    is_enabled AS isEnabled,
    revision,
    created_at AS createdAt,
    updated_at AS updatedAt
  FROM plugin_connections`

  const findRows = ({ pluginConnectionId, workspaceId }: typeof PluginConnectionKey.Type) =>
    sql<Record<string, unknown>>`${selectColumns}
      WHERE workspace_id = ${workspaceId}
        AND plugin_connection_id = ${pluginConnectionId}`

  const listRows = (workspaceId: WorkspaceId) =>
    sql<Record<string, unknown>>`${selectColumns}
      WHERE workspace_id = ${workspaceId}
      ORDER BY display_name, plugin_connection_id`

  const quarantineMalformed = Effect.fn("PluginConnectionRepository.quarantineMalformed")(function*(
    workspaceId: WorkspaceId,
    row: unknown,
    fallbackKey: PluginConnectionId | WorkspaceId
  ) {
    const identity = Schema.decodeUnknownResult(PluginConnectionIdentity)(row)
    const observedAt = yield* DateTime.now
    yield* quarantineRow({
      workspaceId,
      recordKind: "plugin-connection",
      recordKey: Result.isSuccess(identity) ? identity.success.pluginConnectionId : fallbackKey,
      diagnosticCode: "plugin-connection-schema-invalid",
      diagnosticSummary: "Stored plugin connection failed schema validation.",
      observedAt,
      row
    })
  })

  const get = Effect.fn("PluginConnectionRepository.get")(function*(
    workspaceId: WorkspaceId,
    pluginConnectionId: PluginConnectionId
  ) {
    const rows = yield* findRows({ workspaceId, pluginConnectionId }).pipe(
      mapPersistenceOperation("plugin-connection.get")
    )
    if (rows.length === 0) {
      return yield* new RecordNotFoundError({
        workspaceId,
        recordKind: "plugin-connection",
        recordKey: pluginConnectionId
      })
    }
    const decoded = Schema.decodeUnknownResult(PluginConnectionRow)(rows[0])
    if (Result.isSuccess(decoded)) return yield* decodeRecord(decoded.success)
    yield* quarantineMalformed(workspaceId, rows[0], pluginConnectionId)
    return yield* new PersistedRecordError({
      workspaceId,
      recordKind: "plugin-connection",
      recordKey: pluginConnectionId,
      diagnosticCode: "plugin-connection-schema-invalid"
    })
  })

  const insert = SqlSchema.void({
    Request: CreatePluginConnectionRequest,
    execute: ({ createdAt, displayName, isEnabled, pluginConnectionId, providerId, workspaceId }) =>
      sql`INSERT INTO plugin_connections (
            workspace_id, plugin_connection_id, provider_id, display_name,
            revision, is_enabled, created_at, updated_at
          ) VALUES (
            ${workspaceId}, ${pluginConnectionId}, ${providerId}, ${displayName},
            1, ${isEnabled ? 1 : 0}, ${createdAt}, ${createdAt}
          )`
  })

  const update = SqlSchema.void({
    Request: UpdatePluginConnectionRequest,
    execute: ({ displayName, expectedRevision, isEnabled, pluginConnectionId, updatedAt, workspaceId }) =>
      sql`UPDATE plugin_connections
          SET display_name = ${displayName},
              is_enabled = ${isEnabled ? 1 : 0},
              revision = revision + 1,
              updated_at = ${updatedAt}
          WHERE workspace_id = ${workspaceId}
            AND plugin_connection_id = ${pluginConnectionId}
            AND revision = ${expectedRevision}`
  })

  return {
    create: Effect.fn("PluginConnectionRepository.create")(function*(
      workspaceId: WorkspaceId,
      input: {
        readonly pluginConnectionId: PluginConnectionId
        readonly providerId: ProviderId
        readonly displayName: PluginConnectionDisplayName
        readonly isEnabled: boolean
        readonly createdAt: UtcTimestamp
      }
    ) {
      yield* insert({ workspaceId, ...input }).pipe(
        mapAlreadyExists({
          workspaceId,
          recordKind: "plugin-connection",
          recordKey: input.pluginConnectionId
        }),
        mapPersistenceOperation("plugin-connection.create")
      )
      return yield* get(workspaceId, input.pluginConnectionId)
    }),
    get,
    list: Effect.fn("PluginConnectionRepository.list")(function*(workspaceId: WorkspaceId) {
      const rows = yield* listRows(workspaceId).pipe(
        mapPersistenceOperation("plugin-connection.list")
      )
      const records: Array<PluginConnectionRecord> = []
      for (const row of rows) {
        const decoded = Schema.decodeUnknownResult(PluginConnectionRow)(row)
        if (Result.isSuccess(decoded)) {
          records.push(yield* decodeRecord(decoded.success))
        } else {
          yield* quarantineMalformed(workspaceId, row, workspaceId)
        }
      }
      return records
    }),
    updateMetadata: Effect.fn("PluginConnectionRepository.updateMetadata")(function*(
      workspaceId: WorkspaceId,
      pluginConnectionId: PluginConnectionId,
      input: {
        readonly displayName: PluginConnectionDisplayName
        readonly isEnabled: boolean
        readonly expectedRevision: RecordRevision
        readonly updatedAt: UtcTimestamp
      }
    ) {
      yield* database.transaction(
        Effect.gen(function*() {
          yield* update({ workspaceId, pluginConnectionId, ...input })
          const changes = yield* readChanges(sql)
          if (changes === 0) {
            return yield* resolveCasFailure({
              workspaceId,
              recordKind: "plugin-connection",
              recordKey: pluginConnectionId,
              expectedRevision: input.expectedRevision,
              findActualRevision: revisionLookup(() =>
                sql`SELECT revision
                    FROM plugin_connections
                    WHERE workspace_id = ${workspaceId}
                      AND plugin_connection_id = ${pluginConnectionId}`
              )
            })
          }
        })
      ).pipe(mapPersistenceOperation("plugin-connection.update"))
      return yield* get(workspaceId, pluginConnectionId)
    })
  }
})

/** Workspace-isolated plugin-connection persistence without secret material. */
export interface PluginConnectionRepositoryService extends Success<typeof makePluginConnectionRepository> {}

/** Effect service for plugin-connection metadata. */
export class PluginConnectionRepository extends Context.Service<
  PluginConnectionRepository,
  PluginConnectionRepositoryService
>()("@knpkv/control-center/PluginConnectionRepository") {
  /** Layer that binds SQL queries to the shared database at construction. */
  static readonly layer = Layer.effect(PluginConnectionRepository, makePluginConnectionRepository)
}
