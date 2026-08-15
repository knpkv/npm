import * as Context from "effect/Context"
import * as Crypto from "effect/Crypto"
import * as Data from "effect/Data"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import type { Success } from "effect/Effect"
import * as Encoding from "effect/Encoding"
import * as Layer from "effect/Layer"
import * as Predicate from "effect/Predicate"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"

import { PersonId, SessionId, WorkspaceId, WorkspaceSettingsMutationId } from "../../../domain/identifiers.js"
import { UtcTimestamp } from "../../../domain/utcTimestamp.js"
import {
  changedWorkspaceSettingsSections,
  DEFAULT_WORKSPACE_SETTINGS,
  GovernedWorkspaceSettingsSections,
  isGovernedWorkspaceSettingsSection,
  WorkspaceSettingsSections,
  WorkspaceSettingsV1
} from "../../../domain/workspaceSettings.js"
import {
  digestWorkspaceSettingsGovernanceRequest,
  type WorkspaceSettingsGovernanceAuthority,
  workspaceSettingsGovernanceAuthorityMatches
} from "../../governance/GovernedHumanMutationPolicyEvaluator.js"
import { Database } from "../Database.js"
import type { QuarantineWriteError } from "../errors.js"
import {
  PersistedRecordError,
  PersistenceOperationError,
  RecordNotFoundError,
  RevisionConflictError,
  WorkspaceSettingsGovernanceError,
  WorkspaceSettingsMutationConflictError,
  WorkspaceSettingsNoChangesError
} from "../errors.js"
import { mapPersistenceOperation, readChanges } from "./internal.js"
import { ContentBlobDigest, RecordRevision } from "./models.js"
import { makePersistedRowQuarantine } from "./persistedRowQuarantine.js"
import { QuarantineRepository } from "./quarantineRepository.js"
import type { SqlRow } from "./sqlRow.js"

const WorkspaceSettingsRow = Schema.Struct({
  workspaceId: WorkspaceId,
  schemaVersion: Schema.Literal(1),
  revision: RecordRevision,
  policyRevision: RecordRevision,
  settingsJson: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(32_768)),
  settingsDigest: ContentBlobDigest,
  createdAt: UtcTimestamp,
  updatedAt: UtcTimestamp,
  updatedByPersonId: Schema.NullOr(PersonId)
})

/** Decoded current workspace-settings persistence record. */
export const WorkspaceSettingsRecord = Schema.Struct({
  workspaceId: WorkspaceId,
  revision: RecordRevision,
  policyRevision: RecordRevision,
  settings: WorkspaceSettingsV1,
  settingsDigest: ContentBlobDigest,
  createdAt: UtcTimestamp,
  updatedAt: UtcTimestamp,
  updatedByPersonId: Schema.NullOr(PersonId)
})

/** Decoded current workspace-settings persistence record. */
export type WorkspaceSettingsRecord = typeof WorkspaceSettingsRecord.Type

const WorkspaceSettingsAuditRow = Schema.Struct({
  workspaceId: WorkspaceId,
  mutationId: WorkspaceSettingsMutationId,
  requestDigest: ContentBlobDigest,
  fromRevision: RecordRevision,
  toRevision: RecordRevision,
  actorPersonId: PersonId,
  sessionId: SessionId,
  changedSectionsJson: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(256)),
  governed: Schema.Literals([0, 1]),
  governanceAuthorityDigest: Schema.NullOr(ContentBlobDigest),
  beforeDigest: ContentBlobDigest,
  afterDigest: ContentBlobDigest,
  occurredAt: UtcTimestamp
})

/** Immutable attributable record of one successful settings mutation. */
export const WorkspaceSettingsAuditRecord = Schema.Struct({
  workspaceId: WorkspaceId,
  mutationId: WorkspaceSettingsMutationId,
  requestDigest: ContentBlobDigest,
  fromRevision: RecordRevision,
  toRevision: RecordRevision,
  actorPersonId: PersonId,
  sessionId: SessionId,
  changedSections: WorkspaceSettingsSections,
  governed: Schema.Boolean,
  governanceAuthorityDigest: Schema.NullOr(ContentBlobDigest),
  beforeDigest: ContentBlobDigest,
  afterDigest: ContentBlobDigest,
  occurredAt: UtcTimestamp
})

/** Decoded immutable workspace-settings audit. */
export type WorkspaceSettingsAuditRecord = typeof WorkspaceSettingsAuditRecord.Type

/** Internal decoded input accepted by the workspace settings persistence boundary. */
export const UpdateWorkspaceSettingsInput = Schema.Struct({
  mutationId: WorkspaceSettingsMutationId,
  expectedRevision: RecordRevision,
  settings: WorkspaceSettingsV1,
  acknowledgedGovernedSections: GovernedWorkspaceSettingsSections,
  actorPersonId: PersonId,
  sessionId: SessionId,
  updatedAt: UtcTimestamp
})

type UpdateWorkspaceSettingsInput =
  & typeof UpdateWorkspaceSettingsInput.Type
  & {
    readonly governanceAuthority: WorkspaceSettingsGovernanceAuthority | null
  }

const SettingsJson = Schema.fromJsonString(WorkspaceSettingsV1)
const ChangedSectionsJson = Schema.fromJsonString(WorkspaceSettingsSections)
const encodeSettings = Schema.encodeEffect(SettingsJson)
const decodeSettings = Schema.decodeUnknownResult(SettingsJson, {
  onExcessProperty: "error"
})
const encodeChangedSections = Schema.encodeEffect(ChangedSectionsJson)
const decodeChangedSections = Schema.decodeUnknownResult(ChangedSectionsJson)
const governedSectionsEqual = Schema.toEquivalence(GovernedWorkspaceSettingsSections)
const encodeTimestamp = Schema.encodeSync(UtcTimestamp)
const utf8Encoder = new TextEncoder()

class MalformedWorkspaceSettingsRecord extends Data.TaggedError(
  "MalformedWorkspaceSettingsRecord"
)<{
  readonly error: PersistedRecordError
  readonly row: unknown
}> {}

const isMalformedWorkspaceSettingsRecord = <UnparsedInput>(
  failure: UnparsedInput
): failure is UnparsedInput & MalformedWorkspaceSettingsRecord =>
  Predicate.isTagged("MalformedWorkspaceSettingsRecord")(failure) &&
  Predicate.hasProperty(failure, "error") &&
  Schema.is(PersistedRecordError)(failure.error) &&
  Predicate.hasProperty(failure, "row")

const makeWorkspaceSettingsRepository = Effect.gen(function*() {
  const cryptoService = yield* Crypto.Crypto
  const database = yield* Database
  const quarantine = yield* QuarantineRepository
  const quarantineRow = makePersistedRowQuarantine(cryptoService, quarantine)
  const sql = database.sql

  const digestText = Effect.fn("WorkspaceSettingsRepository.digestText")(function*(value: string) {
    const digest = yield* cryptoService.digest("SHA-256", utf8Encoder.encode(value)).pipe(
      Effect.mapError(() => new PersistenceOperationError({ operation: "workspace-settings.digest" }))
    )
    return ContentBlobDigest.make(Encoding.encodeHex(digest))
  })

  const readRows = (workspaceId: WorkspaceId) =>
    sql<SqlRow>`SELECT
      workspace_id AS workspaceId,
      schema_version AS schemaVersion,
      revision,
      policy_revision AS policyRevision,
      settings_json AS settingsJson,
      settings_digest AS settingsDigest,
      created_at AS createdAt,
      updated_at AS updatedAt,
      updated_by_person_id AS updatedByPersonId
    FROM workspace_settings
    WHERE workspace_id = ${workspaceId}`

  const readVersionRows = (
    workspaceId: WorkspaceId,
    revision: RecordRevision
  ) =>
    sql<SqlRow>`SELECT
      workspace_id AS workspaceId,
      schema_version AS schemaVersion,
      revision,
      policy_revision AS policyRevision,
      settings_json AS settingsJson,
      settings_digest AS settingsDigest,
      created_at AS createdAt,
      updated_at AS updatedAt,
      updated_by_person_id AS updatedByPersonId
    FROM workspace_settings_versions
    WHERE workspace_id = ${workspaceId}
      AND revision = ${revision}`

  const readAuditRows = (
    workspaceId: WorkspaceId,
    mutationId?: WorkspaceSettingsMutationId
  ) =>
    sql<SqlRow>`SELECT
      workspace_id AS workspaceId,
      mutation_id AS mutationId,
      request_digest AS requestDigest,
      from_revision AS fromRevision,
      to_revision AS toRevision,
      actor_person_id AS actorPersonId,
      session_id AS sessionId,
      changed_sections_json AS changedSectionsJson,
      governed,
      governance_authority_digest AS governanceAuthorityDigest,
      before_digest AS beforeDigest,
      after_digest AS afterDigest,
      occurred_at AS occurredAt
    FROM workspace_settings_audits
    WHERE workspace_id = ${workspaceId}
      AND (${mutationId ?? null} IS NULL OR mutation_id = ${mutationId ?? null})
    ORDER BY to_revision`

  const quarantineMalformed = Effect.fn("WorkspaceSettingsRepository.quarantineMalformed")(function*<UnparsedInput>(
    workspaceId: WorkspaceId,
    row: UnparsedInput,
    diagnosticCode: "workspace-settings-digest-mismatch" | "workspace-settings-schema-invalid",
    diagnosticSummary:
      | "Stored workspace settings digest does not match its content."
      | "Stored workspace settings failed schema validation."
  ) {
    yield* quarantineRow({
      workspaceId,
      recordKind: "workspace-settings",
      recordKey: workspaceId,
      diagnosticCode,
      diagnosticSummary,
      observedAt: yield* DateTime.now,
      row
    })
  })

  const decodeCurrent = Effect.fn("WorkspaceSettingsRepository.decodeCurrent")(function*<UnparsedInput>(
    workspaceId: WorkspaceId,
    row: UnparsedInput,
    quarantineMode: "deferred" | "immediate"
  ) {
    const failMalformed = (
      error: PersistedRecordError,
      diagnosticCode:
        | "workspace-settings-digest-mismatch"
        | "workspace-settings-schema-invalid",
      diagnosticSummary:
        | "Stored workspace settings digest does not match its content."
        | "Stored workspace settings failed schema validation."
    ) =>
      quarantineMode === "deferred"
        ? Effect.fail(new MalformedWorkspaceSettingsRecord({ error, row }))
        : quarantineMalformed(
          workspaceId,
          row,
          diagnosticCode,
          diagnosticSummary
        ).pipe(Effect.andThen(Effect.fail(error)))
    const decodedRow = Schema.decodeUnknownResult(WorkspaceSettingsRow)(row)
    if (Result.isFailure(decodedRow)) {
      const error = new PersistedRecordError({
        workspaceId,
        recordKind: "workspace-settings",
        recordKey: workspaceId,
        diagnosticCode: "workspace-settings-schema-invalid"
      })
      return yield* failMalformed(
        error,
        "workspace-settings-schema-invalid",
        "Stored workspace settings failed schema validation."
      )
    }
    const settings = decodeSettings(decodedRow.success.settingsJson)
    if (Result.isFailure(settings)) {
      const error = new PersistedRecordError({
        workspaceId,
        recordKind: "workspace-settings",
        recordKey: workspaceId,
        diagnosticCode: "workspace-settings-schema-invalid"
      })
      return yield* failMalformed(
        error,
        "workspace-settings-schema-invalid",
        "Stored workspace settings failed schema validation."
      )
    }
    const actualDigest = yield* digestText(decodedRow.success.settingsJson)
    if (actualDigest !== decodedRow.success.settingsDigest) {
      const error = new PersistedRecordError({
        workspaceId,
        recordKind: "workspace-settings",
        recordKey: workspaceId,
        diagnosticCode: "workspace-settings-digest-mismatch"
      })
      return yield* failMalformed(
        error,
        "workspace-settings-digest-mismatch",
        "Stored workspace settings digest does not match its content."
      )
    }
    return WorkspaceSettingsRecord.make({
      workspaceId,
      revision: decodedRow.success.revision,
      policyRevision: decodedRow.success.policyRevision,
      settings: settings.success,
      settingsDigest: decodedRow.success.settingsDigest,
      createdAt: decodedRow.success.createdAt,
      updatedAt: decodedRow.success.updatedAt,
      updatedByPersonId: decodedRow.success.updatedByPersonId
    })
  })

  const readCurrent = Effect.fn("WorkspaceSettingsRepository.readCurrent")(function*(
    workspaceId: WorkspaceId,
    quarantineMode: "deferred" | "immediate" = "immediate"
  ) {
    const rows = yield* readRows(workspaceId)
    const row = rows[0]
    if (row === undefined) {
      return yield* new RecordNotFoundError({
        workspaceId,
        recordKind: "workspace-settings",
        recordKey: workspaceId
      })
    }
    return yield* decodeCurrent(workspaceId, row, quarantineMode)
  })

  const readVersion = Effect.fn("WorkspaceSettingsRepository.readVersion")(function*(
    workspaceId: WorkspaceId,
    revision: RecordRevision
  ) {
    const rows = yield* readVersionRows(workspaceId, revision)
    const row = rows[0]
    if (row === undefined) {
      return yield* new WorkspaceSettingsMutationConflictError()
    }
    return yield* decodeCurrent(workspaceId, row, "deferred")
  })

  const quarantineAfterRollback = Effect.fn(
    "WorkspaceSettingsRepository.quarantineAfterRollback"
  )(function*(malformed: MalformedWorkspaceSettingsRecord) {
    yield* quarantineMalformed(
      malformed.error.workspaceId,
      malformed.row,
      malformed.error.diagnosticCode ===
          "workspace-settings-digest-mismatch"
        ? "workspace-settings-digest-mismatch"
        : "workspace-settings-schema-invalid",
      malformed.error.diagnosticCode ===
          "workspace-settings-digest-mismatch"
        ? "Stored workspace settings digest does not match its content."
        : "Stored workspace settings failed schema validation."
    )
    return yield* malformed.error
  })

  const decodeAudit = Effect.fn("WorkspaceSettingsRepository.decodeAudit")(
    function*<UnparsedInput>(row: UnparsedInput) {
      const decodedRow = yield* Schema.decodeUnknownEffect(WorkspaceSettingsAuditRow)(row).pipe(
        Effect.mapError(() => new PersistenceOperationError({ operation: "workspace-settings.decode-audit" }))
      )
      const changedSections = decodeChangedSections(decodedRow.changedSectionsJson)
      if (Result.isFailure(changedSections)) {
        return yield* new PersistenceOperationError({ operation: "workspace-settings.decode-audit" })
      }
      return WorkspaceSettingsAuditRecord.make({
        ...decodedRow,
        changedSections: changedSections.success,
        governed: decodedRow.governed === 1
      })
    }
  )

  const ensureDefault = Effect.fn("WorkspaceSettingsRepository.ensureDefault")(function*(
    workspaceId: WorkspaceId
  ) {
    const settingsJson = yield* encodeSettings(DEFAULT_WORKSPACE_SETTINGS).pipe(
      Effect.mapError(() => new PersistenceOperationError({ operation: "workspace-settings.encode-default" }))
    )
    const settingsDigest = yield* digestText(settingsJson)
    yield* database.transaction(
      Effect.gen(function*() {
        yield* sql`INSERT INTO workspace_settings (
          workspace_id, schema_version, revision, settings_json, settings_digest,
          policy_revision, created_at, updated_at, updated_by_person_id
        )
        SELECT workspace_id, 1, 1, ${settingsJson}, ${settingsDigest},
          1, created_at, created_at, NULL
        FROM workspaces
        WHERE workspace_id = ${workspaceId}
        ON CONFLICT(workspace_id) DO NOTHING`
        yield* sql`INSERT INTO workspace_settings_versions (
          workspace_id, schema_version, revision, settings_json, settings_digest,
          policy_revision, created_at, updated_at, updated_by_person_id
        )
        SELECT workspace_id, schema_version, revision, settings_json, settings_digest,
          policy_revision, created_at, updated_at, updated_by_person_id
        FROM workspace_settings
        WHERE workspace_id = ${workspaceId}
          AND revision = 1
        ON CONFLICT(workspace_id, revision) DO NOTHING`
      })
    )
  })

  const replayCommittedMutation = Effect.fn("WorkspaceSettingsRepository.replayCommittedMutation")(function*(
    workspaceId: WorkspaceId,
    audit: WorkspaceSettingsAuditRecord,
    requestDigest: ContentBlobDigest
  ) {
    if (audit.requestDigest !== requestDigest) {
      return yield* new WorkspaceSettingsMutationConflictError()
    }
    const committed = yield* readVersion(workspaceId, audit.toRevision)
    if (committed.settingsDigest !== audit.afterDigest) {
      return yield* new WorkspaceSettingsMutationConflictError()
    }
    return yield* readCurrent(workspaceId, "deferred")
  })

  const get = Effect.fn("WorkspaceSettingsRepository.get")(function*(workspaceId: WorkspaceId) {
    return yield* readCurrent(workspaceId).pipe(
      Effect.catchTag("RecordNotFoundError", () =>
        ensureDefault(workspaceId).pipe(
          mapPersistenceOperation("workspace-settings.ensure-default"),
          Effect.andThen(readCurrent(workspaceId))
        )),
      mapPersistenceOperation("workspace-settings.get")
    )
  })

  const updateWithinTransaction = Effect.fn("WorkspaceSettingsRepository.updateWithinTransaction")(function*(
    workspaceId: WorkspaceId,
    input: UpdateWorkspaceSettingsInput,
    afterUpdate: (
      before: WorkspaceSettingsRecord,
      current: WorkspaceSettingsRecord
    ) => Effect.Effect<unknown, unknown>
  ) {
    const { governanceAuthority, ...untrustedInput } = input
    const decodedInput = yield* Schema.decodeUnknownEffect(
      Schema.toType(UpdateWorkspaceSettingsInput),
      { onExcessProperty: "error" }
    )(untrustedInput).pipe(
      Effect.mapError(() => new PersistenceOperationError({ operation: "workspace-settings.update-input" }))
    )
    const settingsJson = yield* encodeSettings(decodedInput.settings).pipe(
      Effect.mapError(() => new PersistenceOperationError({ operation: "workspace-settings.encode-update" }))
    )
    const settingsDigest = yield* digestText(settingsJson)
    const requestDigest = yield* digestWorkspaceSettingsGovernanceRequest({
      workspaceId,
      mutationId: decodedInput.mutationId,
      expectedRevision: decodedInput.expectedRevision,
      settings: decodedInput.settings,
      acknowledgedGovernedSections: decodedInput.acknowledgedGovernedSections,
      actorPersonId: decodedInput.actorPersonId,
      sessionId: decodedInput.sessionId
    }).pipe(
      Effect.provideService(Crypto.Crypto, cryptoService),
      Effect.mapError(() => new PersistenceOperationError({ operation: "workspace-settings.digest-mutation" }))
    )
    const encodedUpdatedAt = encodeTimestamp(decodedInput.updatedAt)
    yield* ensureDefault(workspaceId).pipe(mapPersistenceOperation("workspace-settings.ensure-default"))

    return yield* database.transaction(
      Effect.gen(function*() {
        const before = yield* readCurrent(workspaceId, "deferred")
        const existingAuditRows = yield* readAuditRows(workspaceId, decodedInput.mutationId)
        if (existingAuditRows.length > 1) {
          return yield* new WorkspaceSettingsMutationConflictError()
        }
        const existingAuditRow = existingAuditRows[0]
        if (existingAuditRow !== undefined) {
          const existingAudit = yield* decodeAudit(existingAuditRow)
          const replayed = yield* replayCommittedMutation(workspaceId, existingAudit, requestDigest)
          yield* afterUpdate(before, replayed)
          return replayed
        }

        const current = before
        if (current.revision !== decodedInput.expectedRevision) {
          return yield* new RevisionConflictError({
            workspaceId,
            recordKind: "workspace-settings",
            recordKey: workspaceId,
            expectedRevision: decodedInput.expectedRevision,
            actualRevision: current.revision
          })
        }

        const changedSections = changedWorkspaceSettingsSections(
          current.settings,
          decodedInput.settings
        )
        if (changedSections.length === 0) {
          return yield* new WorkspaceSettingsNoChangesError()
        }
        const governedSections = changedSections.filter(isGovernedWorkspaceSettingsSection)
        if (
          !governedSectionsEqual(
            governedSections,
            decodedInput.acknowledgedGovernedSections
          ) ||
          (
            governedSections.length > 0 &&
            !workspaceSettingsGovernanceAuthorityMatches(
              governanceAuthority,
              requestDigest,
              decodedInput.updatedAt
            )
          )
        ) {
          return yield* new WorkspaceSettingsGovernanceError()
        }
        const changedSectionsJson = yield* encodeChangedSections(changedSections).pipe(
          Effect.mapError(() =>
            new PersistenceOperationError({
              operation: "workspace-settings.encode-changed-sections"
            })
          )
        )

        yield* sql`UPDATE workspace_settings
          SET revision = revision + 1,
              policy_revision = policy_revision + ${governedSections.length === 0 ? 0 : 1},
              settings_json = ${settingsJson},
              settings_digest = ${settingsDigest},
              updated_by_person_id = ${decodedInput.actorPersonId},
              updated_at = ${encodedUpdatedAt}
          WHERE workspace_id = ${workspaceId}
            AND revision = ${decodedInput.expectedRevision}`
        const changes = yield* readChanges(sql)
        if (changes === 0) {
          const replayRows = yield* readAuditRows(workspaceId, decodedInput.mutationId)
          const replayRow = replayRows[0]
          if (replayRow !== undefined && replayRows.length === 1) {
            const replayAudit = yield* decodeAudit(replayRow)
            return yield* replayCommittedMutation(workspaceId, replayAudit, requestDigest)
          }
          const latest = yield* readCurrent(workspaceId, "deferred")
          return yield* new RevisionConflictError({
            workspaceId,
            recordKind: "workspace-settings",
            recordKey: workspaceId,
            expectedRevision: decodedInput.expectedRevision,
            actualRevision: latest.revision
          })
        }

        const toRevision = RecordRevision.make(decodedInput.expectedRevision + 1)
        yield* sql`INSERT INTO workspace_settings_versions (
          workspace_id, schema_version, revision, settings_json, settings_digest,
          policy_revision, created_at, updated_at, updated_by_person_id
        )
        SELECT workspace_id, schema_version, revision, settings_json, settings_digest,
          policy_revision, created_at, updated_at, updated_by_person_id
        FROM workspace_settings
        WHERE workspace_id = ${workspaceId}
          AND revision = ${toRevision}`
        yield* sql`INSERT INTO workspace_settings_audits (
          workspace_id, mutation_id, request_digest, from_revision, to_revision,
          actor_person_id, session_id, changed_sections_json, governed, governance_authority_digest,
          before_digest, after_digest, occurred_at
        ) VALUES (
          ${workspaceId}, ${decodedInput.mutationId}, ${requestDigest},
          ${decodedInput.expectedRevision}, ${toRevision},
          ${decodedInput.actorPersonId}, ${decodedInput.sessionId}, ${changedSectionsJson},
          ${governedSections.length === 0 ? 0 : 1},
          ${governedSections.length === 0 ? null : requestDigest},
          ${current.settingsDigest}, ${settingsDigest}, ${encodedUpdatedAt}
        )`
        const updated = yield* readCurrent(workspaceId, "deferred")
        yield* afterUpdate(before, updated)
        return updated
      })
    ).pipe(
      Effect.result,
      Effect.flatMap((result) =>
        Result.isFailure(result) &&
          isMalformedWorkspaceSettingsRecord(result.failure)
          ? quarantineAfterRollback(result.failure)
          : Effect.fromResult(result)
      ),
      mapPersistenceOperation("workspace-settings.update")
    )
  })

  const update = Effect.fn("WorkspaceSettingsRepository.update")(function*(
    workspaceId: WorkspaceId,
    input: UpdateWorkspaceSettingsInput
  ) {
    return yield* updateWithinTransaction(workspaceId, input, () => Effect.void)
  })

  /**
   * Run a settings-dependent workflow in the repository-owned transaction so
   * malformed-row quarantine is written only after the complete workflow rolls back.
   */
  const readAtomically = <Value, Failure, Requirements>(
    workspaceId: WorkspaceId,
    use: (
      current: WorkspaceSettingsRecord
    ) => Effect.Effect<Value, Failure, Requirements>
  ): Effect.Effect<
    Value,
    | Failure
    | PersistedRecordError
    | PersistenceOperationError
    | QuarantineWriteError
    | RecordNotFoundError,
    Requirements
  > =>
    database.transaction(
      Effect.gen(function*() {
        const current = yield* readCurrent(workspaceId, "deferred").pipe(
          Effect.catchTag("RecordNotFoundError", () =>
            ensureDefault(workspaceId).pipe(
              Effect.andThen(readCurrent(workspaceId, "deferred"))
            ))
        )
        return yield* use(current)
      })
    ).pipe(
      Effect.result,
      Effect.flatMap((result) => {
        if (Result.isSuccess(result)) return Effect.succeed(result.success)
        return isMalformedWorkspaceSettingsRecord(result.failure)
          ? quarantineAfterRollback(result.failure)
          : Effect.fail(result.failure)
      }),
      mapPersistenceOperation("workspace-settings.read-atomically")
    )

  /**
   * Extend the repository-owned settings transaction with a dependent durable
   * update. Keeping transaction ownership here lets malformed-row quarantine
   * run only after the complete transaction has rolled back.
   */
  const updateAtomically = Effect.fn("WorkspaceSettingsRepository.updateAtomically")(function*(
    workspaceId: WorkspaceId,
    input: UpdateWorkspaceSettingsInput,
    afterUpdate: (
      before: WorkspaceSettingsRecord,
      current: WorkspaceSettingsRecord
    ) => Effect.Effect<unknown, unknown>
  ) {
    return yield* updateWithinTransaction(workspaceId, input, afterUpdate)
  })

  const audits = Effect.fn("WorkspaceSettingsRepository.audits")(function*(
    workspaceId: WorkspaceId
  ) {
    const rows = yield* readAuditRows(workspaceId).pipe(
      mapPersistenceOperation("workspace-settings.audits")
    )
    return yield* Effect.forEach(rows, decodeAudit)
  })

  return { audits, get, readAtomically, update, updateAtomically }
})

/** Durable workspace-settings persistence with CAS and transactional audit. */
export interface WorkspaceSettingsRepositoryService extends
  Success<
    typeof makeWorkspaceSettingsRepository
  >
{}

/** Effect service for the current workspace settings aggregate and immutable audits. */
export class WorkspaceSettingsRepository extends Context.Service<
  WorkspaceSettingsRepository,
  WorkspaceSettingsRepositoryService
>()("@knpkv/control-center/WorkspaceSettingsRepository") {
  /** Layer backed by the shared Control Center database and quarantine services. */
  static readonly layer = Layer.effect(
    WorkspaceSettingsRepository,
    makeWorkspaceSettingsRepository
  )
}
