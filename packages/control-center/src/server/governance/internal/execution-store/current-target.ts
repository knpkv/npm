import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

import { GovernedActionTargetSnapshotV1 } from "../../../../domain/governedAction/index.js"
import { EntityId, WorkspaceId } from "../../../../domain/identifiers.js"
import { PluginEntityType } from "../../../../domain/plugins/events.js"
import { ProviderId, Revision, VendorImmutableId } from "../../../../domain/sourceRevision.js"
import { Database } from "../../../persistence/Database.js"
import { PersistedRecordError, RecordNotFoundError } from "../../../persistence/errors.js"
import { makeDeliveryGraphDecoders } from "../../../persistence/repositories/delivery-graph/decode.js"
import { decodeRows, ProjectionRow } from "../../../persistence/repositories/delivery-graph/rows.js"

const CurrentEntityRow = Schema.Struct({
  workspaceId: WorkspaceId,
  entityId: EntityId,
  entityType: PluginEntityType,
  entityRevision: Schema.Int,
  pluginConnectionId: GovernedActionTargetSnapshotV1.fields.sourceRevision.fields.pluginConnectionId,
  providerId: ProviderId,
  vendorImmutableId: VendorImmutableId,
  sourceRevision: Revision,
  normalizationSchemaVersion: GovernedActionTargetSnapshotV1.fields.sourceRevision.fields.normalizationSchemaVersion,
  sourceUrl: Schema.NullOr(Schema.String),
  firstObservedAt: Schema.String,
  lastObservedAt: Schema.String,
  synchronizedAt: Schema.String
})

type CurrentEntityRow = typeof CurrentEntityRow.Type

const invalidTarget = (workspaceId: WorkspaceId, entityId: EntityId, diagnosticCode: string) =>
  new PersistedRecordError({
    workspaceId,
    recordKind: "governed-action-target",
    recordKey: entityId,
    diagnosticCode
  })

const missingTarget = (workspaceId: WorkspaceId, entityId: EntityId) =>
  new RecordNotFoundError({
    workspaceId,
    recordKind: "governed-action-target",
    recordKey: entityId
  })

const exactlyOne = <Value extends object>(
  values: ReadonlyArray<Value>,
  workspaceId: WorkspaceId,
  entityId: EntityId,
  kind: "entity" | "projection"
): Effect.Effect<Value, PersistedRecordError | RecordNotFoundError> => {
  const value = values[0]
  if (value === undefined) return Effect.fail(missingTarget(workspaceId, entityId))
  return values[1] === undefined
    ? Effect.succeed(value)
    : Effect.fail(invalidTarget(workspaceId, entityId, `current-target-${kind}-ambiguous`))
}

const decodeCurrentEntity = (
  rows: unknown,
  workspaceId: WorkspaceId,
  entityId: EntityId
): Effect.Effect<ReadonlyArray<CurrentEntityRow>, PersistedRecordError> =>
  decodeRows(CurrentEntityRow, rows).pipe(
    Effect.mapError(() => invalidTarget(workspaceId, entityId, "current-target-entity-invalid"))
  )

const decodeCurrentProjection = (
  rows: unknown,
  workspaceId: WorkspaceId,
  entityId: EntityId
) =>
  decodeRows(ProjectionRow, rows).pipe(
    Effect.mapError(() => invalidTarget(workspaceId, entityId, "current-target-projection-invalid"))
  )

/** Strict target reader for the authority-owned execution transaction; it never falls back revisions. */
export const makeGovernedActionCurrentTargetReader = Effect.gen(function*() {
  const { sql } = yield* Database
  const decoders = yield* makeDeliveryGraphDecoders

  const read = Effect.fn("GovernedActionCurrentTargetReader.read")(function*(input: {
    readonly workspaceId: WorkspaceId
    readonly entityId: EntityId
  }) {
    const entityRows = yield* sql`SELECT
      entity.workspace_id AS workspaceId,
      entity.entity_id AS entityId,
      CASE entity.entity_type
        WHEN 'pipeline' THEN 'pipeline-execution'
        ELSE entity.entity_type
      END AS entityType,
      entity.current_revision AS entityRevision,
      entity.plugin_connection_id AS pluginConnectionId,
      entity.provider_id AS providerId,
      entity.vendor_immutable_id AS vendorImmutableId,
      revision.source_revision AS sourceRevision,
      revision.normalization_schema_version AS normalizationSchemaVersion,
      revision.source_url AS sourceUrl,
      revision.first_observed_at AS firstObservedAt,
      revision.last_observed_at AS lastObservedAt,
      revision.synchronized_at AS synchronizedAt
    FROM entities entity
    JOIN entity_revisions revision
      ON revision.workspace_id = entity.workspace_id
      AND revision.entity_id = entity.entity_id
      AND revision.revision = entity.current_revision
    WHERE entity.workspace_id = ${input.workspaceId}
      AND entity.entity_id = ${input.entityId}
    LIMIT 2`
    const entity = yield* exactlyOne(
      yield* decodeCurrentEntity(entityRows, input.workspaceId, input.entityId),
      input.workspaceId,
      input.entityId,
      "entity"
    )

    const projectionRows = yield* sql`SELECT
      projection.workspace_id AS workspaceId,
      projection.entity_id AS entityId,
      projection.projection_revision AS projectionRevision,
      projection.source_entity_revision AS sourceEntityRevision,
      projection.supersedes_projection_revision AS supersedesProjectionRevision,
      projection.projection_schema_version AS projectionSchemaVersion,
      projection.entity_state AS entityState,
      CASE entity.entity_type
        WHEN 'pipeline' THEN 'pipeline-execution'
        ELSE entity.entity_type
      END AS entityType,
      projection.display_key AS displayKey,
      projection.title,
      projection.extension_json AS extensionJson,
      projection.extension_digest AS extensionDigest,
      projection.recorded_at AS recordedAt
    FROM entity_projection_revisions projection
    JOIN entities entity
      ON entity.workspace_id = projection.workspace_id
      AND entity.entity_id = projection.entity_id
    WHERE projection.workspace_id = ${input.workspaceId}
      AND projection.entity_id = ${input.entityId}
      AND projection.projection_revision = (
        SELECT MAX(candidate.projection_revision)
        FROM entity_projection_revisions candidate
        WHERE candidate.workspace_id = projection.workspace_id
          AND candidate.entity_id = projection.entity_id
      )
    LIMIT 2`
    const projectionRow = yield* exactlyOne(
      yield* decodeCurrentProjection(projectionRows, input.workspaceId, input.entityId),
      input.workspaceId,
      input.entityId,
      "projection"
    )
    const { projection } = yield* decoders.decodeProjectionRow(projectionRow)
    if (
      projection.entityState !== "present" ||
      projection.sourceEntityRevision !== entity.entityRevision ||
      projection.entityType !== entity.entityType
    ) {
      return yield* invalidTarget(input.workspaceId, input.entityId, "current-target-projection-mismatch")
    }

    return yield* Schema.decodeUnknownEffect(GovernedActionTargetSnapshotV1)({
      workspaceId: entity.workspaceId,
      entityId: entity.entityId,
      entityType: entity.entityType,
      sourceRevision: {
        providerId: entity.providerId,
        pluginConnectionId: entity.pluginConnectionId,
        vendorImmutableId: entity.vendorImmutableId,
        revision: entity.sourceRevision,
        sourceUrl: entity.sourceUrl,
        firstObservedAt: entity.firstObservedAt,
        lastObservedAt: entity.lastObservedAt,
        synchronizedAt: entity.synchronizedAt,
        normalizationSchemaVersion: entity.normalizationSchemaVersion
      }
    }).pipe(
      Effect.mapError(() => invalidTarget(input.workspaceId, input.entityId, "current-target-snapshot-invalid"))
    )
  })

  return { read }
})
