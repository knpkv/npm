import * as Crypto from "effect/Crypto"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import type { Success } from "effect/Effect"
import * as Encoding from "effect/Encoding"
import * as Layer from "effect/Layer"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"

import { NegotiatedPluginDescriptorV1 } from "../../../domain/plugins/descriptor.js"
import { UtcTimestamp } from "../../../domain/utcTimestamp.js"
import { Database } from "../../persistence/Database.js"
import { PersistedRecordError, PersistenceOperationError } from "../../persistence/errors.js"
import { mapPersistenceOperation } from "../../persistence/repositories/internal.js"
import { StoredPluginConfiguration } from "../../persistence/repositories/pluginConfigurationModels.js"
import {
  CurrentPluginRuntimeAuthority,
  type CurrentPluginRuntimeAuthority as CurrentPluginRuntimeAuthorityType,
  PluginRuntimeAccountDigest,
  type PluginRuntimeAuthorityConfiguration,
  PluginRuntimeAuthorityPublicationConflict,
  PluginRuntimeAuthorityToken,
  PluginRuntimeAuthorityUnavailable,
  PluginRuntimeSourceDigest,
  type PublishPluginRuntimeAuthority
} from "./PluginRuntimeAuthority.js"
import { PluginRuntimeAuthoritySource } from "./PluginRuntimeAuthoritySource.js"

const AUTHORITY_DOMAIN = "@knpkv/control-center/plugin-runtime-authority/v1\0"
const decodeConfigurationJson = Schema.decodeUnknownResult(
  Schema.fromJsonString(StoredPluginConfiguration)
)
const decodeDescriptorJson = Schema.decodeUnknownResult(
  Schema.fromJsonString(NegotiatedPluginDescriptorV1)
)
const encodeTimestamp = Schema.encodeSync(UtcTimestamp)

const SourceRow = Schema.Struct({
  workspaceId: CurrentPluginRuntimeAuthority.fields.scope.fields.workspaceId,
  pluginConnectionId: CurrentPluginRuntimeAuthority.fields.scope.fields.pluginConnectionId,
  providerId: CurrentPluginRuntimeAuthority.fields.expected.fields.providerId,
  connectionRevision: Schema.Int.check(Schema.isGreaterThan(0)),
  isEnabled: Schema.Literals([0, 1]),
  connectionUpdatedAt: UtcTimestamp,
  descriptorJson: Schema.String.check(Schema.isMinLength(2), Schema.isMaxLength(65_536)),
  descriptorDigest: PluginRuntimeSourceDigest,
  descriptorAcceptedAt: UtcTimestamp,
  configurationRevision: Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0))),
  configurationJson: Schema.NullOr(
    Schema.String.check(Schema.isMinLength(2), Schema.isMaxLength(65_536))
  ),
  configurationDigest: Schema.NullOr(PluginRuntimeSourceDigest),
  configurationUpdatedAt: Schema.NullOr(UtcTimestamp)
})

const HeadRow = Schema.Struct({
  workspaceId: CurrentPluginRuntimeAuthority.fields.scope.fields.workspaceId,
  pluginConnectionId: CurrentPluginRuntimeAuthority.fields.scope.fields.pluginConnectionId,
  providerId: CurrentPluginRuntimeAuthority.fields.expected.fields.providerId,
  schemaVersion: Schema.Literal(1),
  generation: Schema.Int.check(Schema.isGreaterThan(0)),
  connectionRevision: Schema.Int.check(Schema.isGreaterThan(0)),
  configurationRevision: Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0))),
  configurationDigest: Schema.NullOr(PluginRuntimeSourceDigest),
  descriptorDigest: PluginRuntimeSourceDigest,
  accountDigest: PluginRuntimeAccountDigest,
  runtimeAuthorityToken: PluginRuntimeAuthorityToken,
  activatedAt: UtcTimestamp
})

const CurrentRow = Schema.Struct({
  ...HeadRow.fields,
  descriptorJson: Schema.String.check(Schema.isMinLength(2), Schema.isMaxLength(65_536)),
  configurationJson: Schema.NullOr(
    Schema.String.check(Schema.isMinLength(2), Schema.isMaxLength(65_536))
  ),
  historyGeneration: Schema.Int.check(Schema.isGreaterThan(0)),
  historyAuthorityToken: PluginRuntimeAuthorityToken
})

type SourceRow = typeof SourceRow.Type
type HeadRow = typeof HeadRow.Type

const persistedInvalid = (input: {
  readonly scope: PublishPluginRuntimeAuthority["scope"]
  readonly diagnosticCode: string
}) =>
  new PersistedRecordError({
    workspaceId: input.scope.workspaceId,
    recordKind: "plugin-runtime-authority",
    recordKey: input.scope.pluginConnectionId,
    diagnosticCode: input.diagnosticCode
  })

const decodeOne = <SchemaType extends Schema.Codec<unknown, unknown, never, never>>(
  schema: SchemaType,
  row: unknown,
  scope: PublishPluginRuntimeAuthority["scope"],
  diagnosticCode: string
): Effect.Effect<SchemaType["Type"], PersistedRecordError, SchemaType["DecodingServices"]> => {
  const decoded = Schema.decodeUnknownResult(schema)(row)
  return Result.isSuccess(decoded)
    ? Effect.succeed(decoded.success)
    : Effect.fail(persistedInvalid({ scope, diagnosticCode }))
}

const configurationFromRow = (
  row: Pick<SourceRow, "configurationDigest" | "configurationJson" | "configurationRevision">
): PluginRuntimeAuthorityConfiguration | null => {
  if (
    row.configurationRevision === null &&
    row.configurationDigest === null &&
    row.configurationJson === null
  ) {
    return { _tag: "absent" }
  }
  if (
    row.configurationRevision !== null &&
    row.configurationDigest !== null &&
    row.configurationJson !== null
  ) {
    return {
      _tag: "present",
      revision: row.configurationRevision,
      digest: row.configurationDigest
    }
  }
  return null
}

const sameConfiguration = (
  left: PluginRuntimeAuthorityConfiguration,
  right: PluginRuntimeAuthorityConfiguration
): boolean =>
  left._tag === right._tag &&
  (left._tag === "absent" ||
    (right._tag === "present" && left.revision === right.revision && left.digest === right.digest))

const sameSourceMaterial = (
  head: HeadRow,
  source: SourceRow,
  configuration: PluginRuntimeAuthorityConfiguration,
  input: PublishPluginRuntimeAuthority
): boolean =>
  head.workspaceId === source.workspaceId &&
  head.pluginConnectionId === source.pluginConnectionId &&
  head.providerId === source.providerId &&
  head.connectionRevision === source.connectionRevision &&
  head.descriptorDigest === source.descriptorDigest &&
  head.accountDigest === input.accountDigest &&
  sameConfiguration(
    head.configurationRevision === null || head.configurationDigest === null
      ? { _tag: "absent" }
      : {
        _tag: "present",
        revision: head.configurationRevision,
        digest: head.configurationDigest
      },
    configuration
  )

/** Stable authority digest over a domain-separated ordered tuple. */
export const digestPluginRuntimeAuthority = Effect.fn("PluginRuntimeAuthority.digest")(function*(
  input: {
    readonly scope: PublishPluginRuntimeAuthority["scope"]
    readonly expected: PublishPluginRuntimeAuthority["expected"]
    readonly accountDigest: PluginRuntimeAccountDigest
    readonly generation: number
  }
) {
  const cryptoService = yield* Crypto.Crypto
  const configuration = input.expected.configuration._tag === "absent"
    ? ["absent"]
    : [
      "present",
      input.expected.configuration.revision,
      input.expected.configuration.digest
    ]
  const tuple = JSON.stringify([
    1,
    input.generation,
    input.scope.workspaceId,
    input.scope.pluginConnectionId,
    input.expected.providerId,
    input.expected.connectionRevision,
    configuration,
    input.expected.descriptorDigest,
    input.accountDigest
  ])
  const bytes = yield* Effect.fromResult(
    Encoding.decodeBase64(Encoding.encodeBase64(`${AUTHORITY_DOMAIN}${tuple}`))
  ).pipe(
    Effect.mapError(() => new PersistenceOperationError({ operation: "plugin-runtime-authority.encode" }))
  )
  const digest = yield* cryptoService.digest("SHA-256", bytes).pipe(
    Effect.mapError(() => new PersistenceOperationError({ operation: "plugin-runtime-authority.digest" }))
  )
  return PluginRuntimeAuthorityToken.make(`sha256:${Encoding.encodeHex(digest)}`)
})

const makePluginRuntimeAuthorityRepository = Effect.gen(function*() {
  const database = yield* Database
  const cryptoService = yield* Crypto.Crypto
  const sql = database.sql

  const digestSourceText = Effect.fn("PluginRuntimeAuthority.digestSourceText")(function*(value: string) {
    const bytes = yield* Effect.fromResult(Encoding.decodeBase64(Encoding.encodeBase64(value))).pipe(
      Effect.mapError(() => new PersistenceOperationError({ operation: "plugin-runtime-authority.encode-source" }))
    )
    const digest = yield* cryptoService.digest("SHA-256", bytes).pipe(
      Effect.mapError(() => new PersistenceOperationError({ operation: "plugin-runtime-authority.digest-source" }))
    )
    return PluginRuntimeSourceDigest.make(Encoding.encodeHex(digest))
  })

  const readSource = Effect.fn("PluginRuntimeAuthority.readSource")(function*(
    input: PublishPluginRuntimeAuthority
  ) {
    const rows = yield* sql`SELECT
      connection.workspace_id AS workspaceId,
      connection.plugin_connection_id AS pluginConnectionId,
      connection.provider_id AS providerId,
      connection.revision AS connectionRevision,
      connection.is_enabled AS isEnabled,
      connection.updated_at AS connectionUpdatedAt,
      runtime.descriptor_json AS descriptorJson,
      runtime.descriptor_digest AS descriptorDigest,
      runtime.accepted_at AS descriptorAcceptedAt,
      configuration.revision AS configurationRevision,
      configuration.configuration_json AS configurationJson,
      configuration.configuration_digest AS configurationDigest,
      configuration.updated_at AS configurationUpdatedAt
    FROM plugin_connections connection
    JOIN plugin_runtime_state runtime
      ON runtime.workspace_id = connection.workspace_id
      AND runtime.plugin_connection_id = connection.plugin_connection_id
      AND runtime.provider_id = connection.provider_id
    LEFT JOIN plugin_configurations configuration
      ON configuration.workspace_id = connection.workspace_id
      AND configuration.plugin_connection_id = connection.plugin_connection_id
    WHERE connection.workspace_id = ${input.scope.workspaceId}
      AND connection.plugin_connection_id = ${input.scope.pluginConnectionId}`
    if (rows.length !== 1) {
      return yield* new PluginRuntimeAuthorityPublicationConflict({ reason: "source-missing" })
    }
    const source = yield* decodeOne(
      SourceRow,
      rows[0],
      input.scope,
      "plugin-runtime-authority-source-invalid"
    )
    if (source.isEnabled !== 1) {
      return yield* new PluginRuntimeAuthorityPublicationConflict({ reason: "source-disabled" })
    }
    const configuration = configurationFromRow(source)
    if (configuration === null) {
      return yield* persistedInvalid({
        scope: input.scope,
        diagnosticCode: "plugin-runtime-authority-configuration-incoherent"
      })
    }
    const descriptor = decodeDescriptorJson(source.descriptorJson)
    const descriptorDigest = yield* digestSourceText(source.descriptorJson)
    const configurationValid = configuration._tag === "absent" ||
      (
        source.configurationJson !== null &&
        Result.isSuccess(decodeConfigurationJson(source.configurationJson)) &&
        (yield* digestSourceText(source.configurationJson)) === configuration.digest
      )
    if (
      Result.isFailure(descriptor) ||
      descriptorDigest !== source.descriptorDigest ||
      !configurationValid
    ) {
      return yield* persistedInvalid({
        scope: input.scope,
        diagnosticCode: "plugin-runtime-authority-source-digest-invalid"
      })
    }
    const latestSourceTime = configuration._tag === "present"
      ? source.configurationUpdatedAt
      : source.descriptorAcceptedAt
    if (
      latestSourceTime === null ||
      DateTime.Order(input.activatedAt, source.connectionUpdatedAt) < 0 ||
      DateTime.Order(input.activatedAt, source.descriptorAcceptedAt) < 0 ||
      DateTime.Order(input.activatedAt, latestSourceTime) < 0 ||
      input.expected.providerId !== source.providerId ||
      input.expected.connectionRevision !== source.connectionRevision ||
      input.expected.descriptorDigest !== source.descriptorDigest ||
      !sameConfiguration(input.expected.configuration, configuration)
    ) {
      return yield* new PluginRuntimeAuthorityPublicationConflict({ reason: "source-changed" })
    }
    return { configuration, source }
  })

  const readRawHead = Effect.fn("PluginRuntimeAuthority.readRawHead")(function*(
    scope: PublishPluginRuntimeAuthority["scope"]
  ) {
    const rows = yield* sql`SELECT
      workspace_id AS workspaceId,
      plugin_connection_id AS pluginConnectionId,
      provider_id AS providerId,
      authority_schema_version AS schemaVersion,
      generation,
      connection_revision AS connectionRevision,
      configuration_revision AS configurationRevision,
      configuration_digest AS configurationDigest,
      descriptor_digest AS descriptorDigest,
      account_digest AS accountDigest,
      authority_digest AS runtimeAuthorityToken,
      activated_at AS activatedAt
    FROM plugin_runtime_authority_heads
    WHERE workspace_id = ${scope.workspaceId}
      AND plugin_connection_id = ${scope.pluginConnectionId}`
    if (rows.length === 0) return null
    if (rows.length !== 1) {
      return yield* persistedInvalid({
        scope,
        diagnosticCode: "plugin-runtime-authority-head-cardinality-invalid"
      })
    }
    return yield* decodeOne(HeadRow, rows[0], scope, "plugin-runtime-authority-head-invalid")
  })

  const loadCurrent = Effect.fn("PluginRuntimeAuthority.loadCurrent")(function*(
    scope: PublishPluginRuntimeAuthority["scope"],
    runtimeAuthorityToken: PluginRuntimeAuthorityToken
  ) {
    const rows = yield* sql`SELECT
      authority.workspace_id AS workspaceId,
      authority.plugin_connection_id AS pluginConnectionId,
      authority.provider_id AS providerId,
      authority.authority_schema_version AS schemaVersion,
      authority.generation,
      authority.connection_revision AS connectionRevision,
      authority.configuration_revision AS configurationRevision,
      authority.configuration_digest AS configurationDigest,
      authority.descriptor_digest AS descriptorDigest,
      authority.account_digest AS accountDigest,
      authority.authority_digest AS runtimeAuthorityToken,
      authority.activated_at AS activatedAt,
      runtime.descriptor_json AS descriptorJson,
      configuration.configuration_json AS configurationJson,
      history.generation AS historyGeneration,
      history.authority_digest AS historyAuthorityToken
    FROM current_plugin_runtime_authority_heads authority
    JOIN plugin_runtime_state runtime
      ON runtime.workspace_id = authority.workspace_id
      AND runtime.plugin_connection_id = authority.plugin_connection_id
      AND runtime.provider_id = authority.provider_id
      AND runtime.descriptor_digest = authority.descriptor_digest
    LEFT JOIN plugin_configurations configuration
      ON configuration.workspace_id = authority.workspace_id
      AND configuration.plugin_connection_id = authority.plugin_connection_id
    JOIN plugin_runtime_authority_generations history
      ON history.workspace_id = authority.workspace_id
      AND history.plugin_connection_id = authority.plugin_connection_id
      AND history.generation = authority.generation
      AND history.authority_digest = authority.authority_digest
    WHERE authority.workspace_id = ${scope.workspaceId}
      AND authority.plugin_connection_id = ${scope.pluginConnectionId}
      AND authority.authority_digest = ${runtimeAuthorityToken}`
    if (rows.length === 0) return yield* new PluginRuntimeAuthorityUnavailable()
    if (rows.length !== 1) {
      return yield* persistedInvalid({
        scope,
        diagnosticCode: "plugin-runtime-authority-current-cardinality-invalid"
      })
    }
    const row = yield* decodeOne(
      CurrentRow,
      rows[0],
      scope,
      "plugin-runtime-authority-current-invalid"
    )
    const configuration = configurationFromRow(row)
    if (
      configuration === null ||
      row.historyGeneration !== row.generation ||
      row.historyAuthorityToken !== row.runtimeAuthorityToken ||
      Result.isFailure(decodeDescriptorJson(row.descriptorJson)) ||
      (yield* digestSourceText(row.descriptorJson)) !== row.descriptorDigest ||
      (
        configuration._tag === "present" &&
        (
          row.configurationJson === null ||
          Result.isFailure(decodeConfigurationJson(row.configurationJson)) ||
          (yield* digestSourceText(row.configurationJson)) !== configuration.digest
        )
      )
    ) {
      return yield* persistedInvalid({
        scope,
        diagnosticCode: "plugin-runtime-authority-current-digest-invalid"
      })
    }
    const current = yield* decodeOne(
      Schema.toType(CurrentPluginRuntimeAuthority),
      {
        scope,
        expected: {
          providerId: row.providerId,
          connectionRevision: row.connectionRevision,
          configuration,
          descriptorDigest: row.descriptorDigest
        },
        accountDigest: row.accountDigest,
        activatedAt: row.activatedAt,
        schemaVersion: row.schemaVersion,
        generation: row.generation,
        runtimeAuthorityToken: row.runtimeAuthorityToken
      },
      scope,
      "plugin-runtime-authority-current-invalid"
    )
    const expectedToken = yield* digestPluginRuntimeAuthority({
      scope: current.scope,
      expected: current.expected,
      accountDigest: current.accountDigest,
      generation: current.generation
    }).pipe(Effect.provideService(Crypto.Crypto, cryptoService))
    if (expectedToken !== current.runtimeAuthorityToken) {
      return yield* persistedInvalid({
        scope,
        diagnosticCode: "plugin-runtime-authority-token-invalid"
      })
    }
    return current
  })

  const publish = Effect.fn("PluginRuntimeAuthority.publish")(function*(
    input: PublishPluginRuntimeAuthority
  ) {
    return yield* database.transaction(
      Effect.gen(function*() {
        const { configuration, source } = yield* readSource(input)
        const previous = yield* readRawHead(input.scope)
        if (
          previous !== null &&
          sameSourceMaterial(previous, source, configuration, input)
        ) {
          return yield* loadCurrent(input.scope, previous.runtimeAuthorityToken).pipe(
            Effect.catchTag("PluginRuntimeAuthorityUnavailable", () =>
              persistedInvalid({
                scope: input.scope,
                diagnosticCode: "plugin-runtime-authority-head-not-current"
              }))
          )
        }

        const generation = previous === null ? 1 : previous.generation + 1
        const runtimeAuthorityToken = yield* digestPluginRuntimeAuthority({
          scope: input.scope,
          expected: input.expected,
          accountDigest: input.accountDigest,
          generation
        }).pipe(Effect.provideService(Crypto.Crypto, cryptoService))
        const configurationRevision = configuration._tag === "present"
          ? configuration.revision
          : null
        const configurationDigest = configuration._tag === "present"
          ? configuration.digest
          : null
        const activatedAt = encodeTimestamp(input.activatedAt)

        const changed = previous === null
          ? yield* sql<{ readonly generation: number }>`INSERT INTO plugin_runtime_authority_heads (
            workspace_id, plugin_connection_id, provider_id, authority_schema_version,
            generation, connection_revision, configuration_revision, configuration_digest,
            descriptor_digest, account_digest, authority_digest, activated_at
          ) VALUES (
            ${input.scope.workspaceId}, ${input.scope.pluginConnectionId},
            ${input.expected.providerId}, 1, ${generation},
            ${input.expected.connectionRevision}, ${configurationRevision},
            ${configurationDigest}, ${input.expected.descriptorDigest},
            ${input.accountDigest}, ${runtimeAuthorityToken}, ${activatedAt}
          ) ON CONFLICT(workspace_id, plugin_connection_id) DO NOTHING
          RETURNING generation`
          : yield* sql<{ readonly generation: number }>`UPDATE plugin_runtime_authority_heads SET
            generation = ${generation},
            connection_revision = ${input.expected.connectionRevision},
            configuration_revision = ${configurationRevision},
            configuration_digest = ${configurationDigest},
            descriptor_digest = ${input.expected.descriptorDigest},
            account_digest = ${input.accountDigest},
            authority_digest = ${runtimeAuthorityToken},
            activated_at = ${activatedAt}
          WHERE workspace_id = ${input.scope.workspaceId}
            AND plugin_connection_id = ${input.scope.pluginConnectionId}
            AND generation = ${previous.generation}
          RETURNING generation`
        if (changed.length !== 1 || changed[0]?.generation !== generation) {
          return yield* new PluginRuntimeAuthorityPublicationConflict({
            reason: "concurrent-publication"
          })
        }
        return yield* loadCurrent(input.scope, runtimeAuthorityToken).pipe(
          Effect.catchTag(
            "PluginRuntimeAuthorityUnavailable",
            () => new PluginRuntimeAuthorityPublicationConflict({ reason: "source-changed" })
          )
        )
      })
    ).pipe(mapPersistenceOperation("plugin-runtime-authority.publish"))
  })

  const transactCurrent = <Success, Failure, Requirements>(
    input: {
      readonly scope: PublishPluginRuntimeAuthority["scope"]
      readonly runtimeAuthorityToken: PluginRuntimeAuthorityToken
    },
    use: (
      current: CurrentPluginRuntimeAuthorityType
    ) => Effect.Effect<Success, Failure, Requirements>
  ) =>
    database.transaction(
      Effect.flatMap(
        loadCurrent(input.scope, input.runtimeAuthorityToken),
        use
      )
    ).pipe(mapPersistenceOperation("plugin-runtime-authority.transact-current"))

  return { publish, transactCurrent }
})

/** Internal live layer for persisted plugin-runtime authority. */
export const pluginRuntimeAuthoritySourceLayer = Layer.effect(
  PluginRuntimeAuthoritySource,
  makePluginRuntimeAuthorityRepository
)

/** Concrete service shape, exported only for internal composition tests. */
export type PluginRuntimeAuthorityRepositoryService = Success<
  typeof makePluginRuntimeAuthorityRepository
>
