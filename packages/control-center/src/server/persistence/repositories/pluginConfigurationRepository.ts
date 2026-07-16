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

import type { PluginConnectionId, WorkspaceId } from "../../../domain/identifiers.js"
import { UtcTimestamp, type UtcTimestamp as UtcTimestampType } from "../../../domain/utcTimestamp.js"
import { Database } from "../Database.js"
import {
  PersistedRecordError,
  PersistenceOperationError,
  RevisionConflictError,
  SecretReferenceScopeConflictError
} from "../errors.js"
import { mapPersistenceOperation, readChanges, revisionLookup } from "./internal.js"
import { ContentBlobDigest } from "./models.js"
import {
  PluginConfigurationRecord,
  StoredPluginConfiguration,
  type StoredPluginConfiguration as StoredPluginConfigurationType
} from "./pluginConfigurationModels.js"
import { QuarantineRepository } from "./quarantineRepository.js"

const PluginConfigurationRow = Schema.Struct({
  workspaceId: Schema.String,
  pluginConnectionId: Schema.String,
  revision: Schema.Int.check(Schema.isGreaterThan(0)),
  configurationJson: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(65_536)),
  configurationDigest: ContentBlobDigest,
  createdAt: Schema.String,
  updatedAt: Schema.String
})

const ConfigurationJson = Schema.fromJsonString(StoredPluginConfiguration)
const encodeConfiguration = Schema.encodeEffect(ConfigurationJson)
const decodeConfiguration = Schema.decodeUnknownResult(ConfigurationJson)
const encodeTimestamp = Schema.encodeSync(UtcTimestamp)

const makePluginConfigurationRepository = Effect.gen(function*() {
  const cryptoService = yield* Crypto.Crypto
  const database = yield* Database
  const quarantine = yield* QuarantineRepository
  const sql = database.sql

  const digestText = Effect.fn("PluginConfigurationRepository.digestText")(function*(value: string) {
    const bytes = yield* Effect.fromResult(Encoding.decodeBase64(Encoding.encodeBase64(value))).pipe(
      Effect.mapError(() => new PersistenceOperationError({ operation: "plugin-configuration.digest" }))
    )
    const digest = yield* cryptoService.digest("SHA-256", bytes).pipe(
      Effect.mapError(() => new PersistenceOperationError({ operation: "plugin-configuration.digest" }))
    )
    return ContentBlobDigest.make(Encoding.encodeHex(digest))
  })

  const readRows = (workspaceId: WorkspaceId, pluginConnectionId: PluginConnectionId) =>
    sql<Record<string, unknown>>`SELECT
      workspace_id AS workspaceId,
      plugin_connection_id AS pluginConnectionId,
      revision,
      configuration_json AS configurationJson,
      configuration_digest AS configurationDigest,
      created_at AS createdAt,
      updated_at AS updatedAt
    FROM plugin_configurations
    WHERE workspace_id = ${workspaceId}
      AND plugin_connection_id = ${pluginConnectionId}`

  const quarantineMalformed = Effect.fn("PluginConfigurationRepository.quarantineMalformed")(function*(
    workspaceId: WorkspaceId,
    pluginConnectionId: PluginConnectionId,
    row: unknown
  ) {
    const serialized = yield* Effect.try({
      try: () => JSON.stringify(row),
      catch: () => "<unserializable>"
    })
    yield* quarantine.recordMalformed(workspaceId, {
      recordKind: "plugin-configuration",
      recordKey: pluginConnectionId,
      schemaVersion: 1,
      payloadDigest: yield* digestText(serialized),
      diagnosticCode: "plugin-configuration-schema-invalid",
      diagnosticSummary: "Stored plugin configuration failed schema validation.",
      observedAt: yield* DateTime.now
    })
  })

  const get = Effect.fn("PluginConfigurationRepository.get")(function*(
    workspaceId: WorkspaceId,
    pluginConnectionId: PluginConnectionId
  ) {
    const rows = yield* readRows(workspaceId, pluginConnectionId).pipe(
      mapPersistenceOperation("plugin-configuration.get")
    )
    if (rows.length === 0) return Option.none<typeof PluginConfigurationRecord.Type>()

    const decodedRow = Schema.decodeUnknownResult(PluginConfigurationRow)(rows[0])
    if (Result.isFailure(decodedRow)) {
      yield* quarantineMalformed(workspaceId, pluginConnectionId, rows[0])
      return yield* new PersistedRecordError({
        workspaceId,
        recordKind: "plugin-configuration",
        recordKey: pluginConnectionId,
        diagnosticCode: "plugin-configuration-schema-invalid"
      })
    }
    const values = decodeConfiguration(decodedRow.success.configurationJson)
    const actualDigest = yield* digestText(decodedRow.success.configurationJson)
    if (Result.isFailure(values)) {
      yield* quarantineMalformed(workspaceId, pluginConnectionId, rows[0])
      return yield* new PersistedRecordError({
        workspaceId,
        recordKind: "plugin-configuration",
        recordKey: pluginConnectionId,
        diagnosticCode: "plugin-configuration-schema-invalid"
      })
    }
    const record = Schema.decodeUnknownResult(PluginConfigurationRecord)({
      ...decodedRow.success,
      workspaceId,
      pluginConnectionId,
      values: values.success
    })
    if (Result.isFailure(record) || actualDigest !== decodedRow.success.configurationDigest) {
      yield* quarantineMalformed(workspaceId, pluginConnectionId, rows[0])
      return yield* new PersistedRecordError({
        workspaceId,
        recordKind: "plugin-configuration",
        recordKey: pluginConnectionId,
        diagnosticCode: "plugin-configuration-schema-invalid"
      })
    }
    return Option.some(record.success)
  })

  const update = Effect.fn("PluginConfigurationRepository.update")(function*(
    workspaceId: WorkspaceId,
    pluginConnectionId: PluginConnectionId,
    values: StoredPluginConfigurationType,
    expectedRevision: number,
    updatedAt: UtcTimestampType
  ) {
    const decodedValues = yield* Schema.decodeUnknownEffect(StoredPluginConfiguration)(values)
    const configurationJson = yield* encodeConfiguration(decodedValues).pipe(
      Effect.mapError(() => new PersistenceOperationError({ operation: "plugin-configuration.encode" }))
    )
    const configurationDigest = yield* digestText(configurationJson)
    const encodedUpdatedAt = encodeTimestamp(updatedAt)

    yield* database.transaction(
      Effect.gen(function*() {
        for (const value of decodedValues) {
          if (value._tag !== "secret-reference") continue
          yield* sql`INSERT INTO plugin_secret_bindings (
            secret_ref, workspace_id, plugin_connection_id, field_key
          ) VALUES (
            ${value.ref}, ${workspaceId}, ${pluginConnectionId}, ${value.key}
          ) ON CONFLICT(secret_ref) DO NOTHING`.pipe(
            mapPersistenceOperation("plugin-configuration.bind-secret")
          )
          const exactBinding = yield* sql<{ readonly bound: number }>`SELECT 1 AS bound
            FROM plugin_secret_bindings
            WHERE secret_ref = ${value.ref}
              AND workspace_id = ${workspaceId}
              AND plugin_connection_id = ${pluginConnectionId}
              AND field_key = ${value.key}`.pipe(
            mapPersistenceOperation("plugin-configuration.verify-secret-binding")
          )
          if (exactBinding.length !== 1) return yield* new SecretReferenceScopeConflictError()
        }
        if (expectedRevision === 0) {
          yield* sql`INSERT INTO plugin_configurations (
            workspace_id, plugin_connection_id, revision, configuration_json,
            configuration_digest, created_at, updated_at
          ) VALUES (
            ${workspaceId}, ${pluginConnectionId}, 1, ${configurationJson},
            ${configurationDigest}, ${encodedUpdatedAt}, ${encodedUpdatedAt}
          ) ON CONFLICT(workspace_id, plugin_connection_id) DO NOTHING`.pipe(
            mapPersistenceOperation("plugin-configuration.insert")
          )
        } else {
          yield* sql`UPDATE plugin_configurations
            SET revision = revision + 1,
                configuration_json = ${configurationJson},
                configuration_digest = ${configurationDigest},
                updated_at = ${encodedUpdatedAt}
            WHERE workspace_id = ${workspaceId}
              AND plugin_connection_id = ${pluginConnectionId}
              AND revision = ${expectedRevision}`.pipe(
            mapPersistenceOperation("plugin-configuration.cas-update")
          )
        }
        const changes = yield* readChanges(sql)
        if (changes !== 0) return
        const actual = yield* revisionLookup(() =>
          sql`SELECT revision
            FROM plugin_configurations
            WHERE workspace_id = ${workspaceId}
              AND plugin_connection_id = ${pluginConnectionId}`
        )
        return yield* new RevisionConflictError({
          workspaceId,
          recordKind: "plugin-configuration",
          recordKey: pluginConnectionId,
          expectedRevision,
          actualRevision: Option.isSome(actual) ? actual.value.revision : null
        })
      }).pipe(mapPersistenceOperation("plugin-configuration.update"))
    )

    const persisted = yield* get(workspaceId, pluginConnectionId)
    if (Option.isNone(persisted)) {
      return yield* new PersistenceOperationError({ operation: "plugin-configuration.update" })
    }
    return persisted.value
  })

  return { get, update }
})

/** Durable plugin-configuration service with CAS updates and opaque secret references. */
export type PluginConfigurationRepositoryService = Success<typeof makePluginConfigurationRepository>

/** Effect service for revisioned plugin configuration. */
export class PluginConfigurationRepository extends Context.Service<
  PluginConfigurationRepository,
  PluginConfigurationRepositoryService
>()("@knpkv/control-center/PluginConfigurationRepository") {
  static readonly layer = Layer.effect(PluginConfigurationRepository, makePluginConfigurationRepository)
}
