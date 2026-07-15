import * as Crypto from "effect/Crypto"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

import type { GovernedActionProviderLineage } from "../../../../domain/governedAction/index.js"
import {
  advanceGovernedActionLifecycle,
  governedActionAuthorityMismatches,
  GovernedActionLifecycleHeadV1,
  GovernedActionTransitionV1
} from "../../../../domain/governedAction/index.js"
import { UtcTimestamp } from "../../../../domain/utcTimestamp.js"
import {
  digestGovernedActionTransition,
  digestGovernedActionTransitionCommand,
  makeGovernedActionTransition,
  verifyGovernedActionEnvelope
} from "../../../governance/governedActionDigests.js"
import { Database } from "../../Database.js"
import { PersistenceOperationError } from "../../errors.js"
import { mapPersistenceOperation, readChanges } from "../internal.js"
import { decodeGovernedActionAuthorizationRow } from "./codec.js"
import { GovernedActionCommitInput, type GovernedActionCommitResult } from "./contract.js"
import { captureMalformedGovernedActionRow } from "./quarantine.js"
import { GovernedActionAuthorizationRow } from "./rows.js"
import {
  causeColumns,
  CauseJson,
  commandColumns,
  CommandJson,
  encodeJson,
  encodeTimestamp,
  EnvelopeJson,
  inputError,
  lineageColumns,
  LineageJson,
  persistedError,
  prepareCompanion,
  type PreparedCompanion,
  TransitionJson
} from "./write-preparation.js"
import { makeGovernedActionReplay } from "./write-replay.js"

const RootRow = Schema.Struct({
  actionId: Schema.String,
  pluginConnectionId: Schema.String,
  providerId: Schema.String,
  targetEntityId: Schema.String,
  idempotencyKey: Schema.String,
  envelopeDigest: Schema.String,
  envelopeJson: Schema.String,
  state: Schema.NullOr(Schema.String),
  lineageJson: Schema.NullOr(Schema.String),
  lineageKind: Schema.NullOr(Schema.String),
  providerOperationId: Schema.NullOr(Schema.String),
  reconciliationKey: Schema.NullOr(Schema.String),
  terminalStatus: Schema.NullOr(Schema.String),
  headTransitionId: Schema.NullOr(Schema.String),
  headSequence: Schema.NullOr(Schema.Int),
  persistedHeadTransitionId: Schema.NullOr(Schema.String),
  updatedAt: Schema.String
})

const SessionAuthorityRow = Schema.Struct({
  personId: Schema.String,
  permission: Schema.String
})

type RootRow = typeof RootRow.Type

interface RootHead {
  readonly state: typeof GovernedActionTransitionV1.Type["toState"]
  readonly lineage: typeof GovernedActionProviderLineage.Type
  readonly transitionId: GovernedActionCommitInput["transitionId"]
  readonly sequence: number
  readonly updatedAt: typeof UtcTimestamp.Type
}

const makeGovernedActionTransactionWriter = Effect.gen(function*() {
  const database = yield* Database
  const cryptoService = yield* Crypto.Crypto
  const sql = database.sql
  const replay = makeGovernedActionReplay(cryptoService)

  const decodeRootRows = Effect.fn("GovernedActionWriter.decodeRootRows")(function*(
    input: GovernedActionCommitInput,
    rows: ReadonlyArray<unknown>
  ) {
    return yield* Schema.decodeUnknownEffect(Schema.Array(RootRow))(rows).pipe(
      Effect.mapError(() =>
        persistedError(input, "governed-action", input.envelope.actionId, "governed-action-schema-invalid")
      )
    )
  })

  const verifyRootIdentity = Effect.fn("GovernedActionWriter.verifyRootIdentity")(function*(
    input: GovernedActionCommitInput,
    expectedEnvelopeJson: string,
    row: RootRow
  ) {
    const envelope = yield* Schema.decodeUnknownEffect(EnvelopeJson)(row.envelopeJson).pipe(
      Effect.mapError(() => persistedError(input, "governed-action", row.actionId, "governed-action-schema-invalid"))
    )
    yield* verifyGovernedActionEnvelope(envelope).pipe(
      Effect.provideService(Crypto.Crypto, cryptoService),
      Effect.mapError(() => persistedError(input, "governed-action", row.actionId, "governed-action-digest-mismatch"))
    )
    const canonicalEnvelope = yield* encodeJson(
      "governed-action.encode-stored-envelope",
      EnvelopeJson,
      envelope
    ).pipe(
      Effect.mapError(() => persistedError(input, "governed-action", row.actionId, "governed-action-schema-invalid"))
    )
    if (
      row.actionId !== input.envelope.actionId ||
      row.pluginConnectionId !== input.envelope.pluginConnectionId ||
      row.providerId !== input.envelope.providerId ||
      row.targetEntityId !== input.envelope.targetEntityId ||
      row.idempotencyKey !== input.envelope.idempotencyKey ||
      row.envelopeDigest !== input.envelope.envelopeDigest ||
      canonicalEnvelope !== expectedEnvelopeJson
    ) {
      return yield* inputError("conflicting-action-identity")
    }
  })

  const decodeRootHead = Effect.fn("GovernedActionWriter.decodeRootHead")(function*(
    input: GovernedActionCommitInput,
    row: RootRow
  ) {
    if (
      row.state === null ||
      row.lineageJson === null ||
      row.headTransitionId === null ||
      row.headSequence === null
    ) {
      return yield* persistedError(input, "governed-action", row.actionId, "governed-action-head-mismatch")
    }
    const malformedHead = () => persistedError(input, "governed-action", row.actionId, "governed-action-head-mismatch")
    const state = yield* Schema.decodeUnknownEffect(GovernedActionTransitionV1.fields.toState)(row.state).pipe(
      Effect.mapError(malformedHead)
    )
    const lineage = yield* Schema.decodeUnknownEffect(LineageJson)(row.lineageJson).pipe(
      Effect.mapError(malformedHead)
    )
    const canonicalLineage = yield* encodeJson(
      "governed-action.encode-stored-lineage",
      LineageJson,
      lineage
    ).pipe(Effect.mapError(malformedHead))
    if (canonicalLineage !== row.lineageJson) return yield* malformedHead()
    const updatedAt = yield* Schema.decodeUnknownEffect(UtcTimestamp)(row.updatedAt).pipe(
      Effect.mapError(malformedHead)
    )
    const transitionId = yield* Schema.decodeUnknownEffect(
      GovernedActionTransitionV1.fields.transitionId
    )(row.headTransitionId).pipe(Effect.mapError(malformedHead))
    const lifecycle = yield* Schema.decodeUnknownEffect(Schema.toType(GovernedActionLifecycleHeadV1))({
      state,
      lineage
    }).pipe(
      Effect.mapError(malformedHead)
    )
    const normalizedLineage = lineageColumns(lifecycle.lineage)
    if (
      row.persistedHeadTransitionId !== row.headTransitionId ||
      row.lineageKind !== normalizedLineage.kind ||
      row.providerOperationId !== normalizedLineage.providerOperationId ||
      row.reconciliationKey !== normalizedLineage.reconciliationKey ||
      row.terminalStatus !== normalizedLineage.terminalStatus
    ) {
      return yield* malformedHead()
    }
    return {
      state: lifecycle.state,
      lineage: lifecycle.lineage,
      transitionId,
      sequence: row.headSequence,
      updatedAt
    }
  })

  const insertCompanion = Effect.fn("GovernedActionWriter.insertCompanion")(function*(
    prepared: PreparedCompanion
  ) {
    switch (prepared._tag) {
      case "none":
        return
      case "authorization": {
        const authorization = prepared.value.authorization
        const sessionRows = yield* sql`SELECT person_id AS personId, permission
          FROM sessions
          WHERE workspace_id = ${authorization.workspaceId}
            AND session_id = ${authorization.sessionId}`
        const sessions = yield* Schema.decodeUnknownEffect(Schema.Array(SessionAuthorityRow))(sessionRows).pipe(
          Effect.mapError(() => new PersistenceOperationError({ operation: "governed-action.read-session-authority" }))
        )
        if (
          sessions.length !== 1 ||
          sessions[0]?.personId !== authorization.actor.personId ||
          sessions[0]?.permission !== authorization.sessionPermission
        ) {
          return yield* inputError("illegal-transition")
        }
        yield* sql`INSERT INTO governed_action_authorizations (
          workspace_id, action_id, authorization_id, session_id, envelope_digest,
          authorization_digest, authorization_json, authorized_at, expires_at
        ) VALUES (
          ${authorization.workspaceId}, ${authorization.actionId}, ${authorization.authorizationId},
          ${authorization.sessionId}, ${authorization.actionEnvelopeDigest}, ${prepared.digest},
          ${prepared.json}, ${prepared.authorizedAt}, ${prepared.expiresAt}
        )`
        return
      }
      case "policyDenial":
      case "dispatch": {
        const evaluation = prepared.value.policyEvaluation
        yield* sql`INSERT INTO governed_action_policy_evaluations (
          workspace_id, action_id, evaluation_digest, evaluation_json, decision, evaluated_at
        ) VALUES (
          ${evaluation.workspaceId}, ${evaluation.actionId}, ${prepared.evaluationDigest},
          ${prepared.evaluationJson}, ${evaluation.decision}, ${prepared.evaluatedAt}
        )`
        if (prepared._tag === "policyDenial") return
        const attempt = prepared.value.attempt
        yield* sql`INSERT INTO governed_action_attempts (
          workspace_id, action_id, attempt_id, authorization_id, policy_evaluation_digest,
          attempt_digest, attempt_number, attempt_json, started_at
        ) VALUES (
          ${attempt.workspaceId}, ${attempt.actionId}, ${attempt.attemptId}, ${attempt.authorizationId},
          ${prepared.evaluationDigest}, ${prepared.attemptDigest}, ${attempt.attemptNumber},
          ${prepared.attemptJson}, ${prepared.startedAt}
        )`
      }
    }
  })

  const verifyDispatchAuthorization = Effect.fn(
    "GovernedActionWriter.verifyDispatchAuthorization"
  )(function*(
    input: GovernedActionCommitInput,
    prepared: PreparedCompanion,
    mode: "commit" | "replay"
  ) {
    if (prepared._tag !== "dispatch") return
    const attempt = prepared.value.attempt
    const authorizationRawRows = yield* sql`SELECT
      workspace_id AS workspaceId, action_id AS actionId, authorization_id AS authorizationId,
      session_id AS sessionId, envelope_digest AS envelopeDigest,
      authorization_digest AS authorizationDigest, authorization_json AS authorizationJson,
      authorized_at AS authorizedAt, expires_at AS expiresAt
    FROM governed_action_authorizations
    WHERE workspace_id = ${attempt.workspaceId}
      AND action_id = ${attempt.actionId}
      AND authorization_id = ${attempt.authorizationId}
    LIMIT 2`
    const authorizationRows = yield* Schema.decodeUnknownEffect(
      Schema.Array(GovernedActionAuthorizationRow)
    )(authorizationRawRows).pipe(
      Effect.mapError(() =>
        persistedError(
          input,
          "governed-action-authorization",
          attempt.authorizationId,
          "governed-action-companion-invalid"
        )
      ),
      captureMalformedGovernedActionRow(authorizationRawRows)
    )
    const authorizationRow = authorizationRows[0]
    if (authorizationRows.length !== 1 || authorizationRow === undefined) {
      if (mode === "commit") return yield* inputError("illegal-transition")
      return yield* Effect.fail(
        persistedError(
          input,
          "governed-action-authorization",
          attempt.authorizationId,
          "governed-action-companion-invalid"
        )
      ).pipe(captureMalformedGovernedActionRow(authorizationRawRows))
    }
    const authorization = yield* decodeGovernedActionAuthorizationRow(authorizationRow).pipe(
      Effect.provideService(Crypto.Crypto, cryptoService),
      captureMalformedGovernedActionRow(authorizationRow)
    )
    const mismatches = governedActionAuthorityMismatches({
      envelope: input.envelope,
      authorization,
      attempt,
      evaluatedAt: attempt.startedAt
    })
    if (mismatches.length === 0) return
    if (mode === "commit") return yield* inputError("illegal-transition")
    return yield* Effect.fail(
      persistedError(
        input,
        "governed-action-authorization",
        attempt.authorizationId,
        "governed-action-companion-invalid"
      )
    ).pipe(captureMalformedGovernedActionRow(authorizationRow))
  })

  const commit = Effect.fn("GovernedActionWriter.commit")(function*(input: GovernedActionCommitInput) {
    yield* Schema.decodeUnknownEffect(Schema.toType(GovernedActionCommitInput))(input).pipe(
      Effect.mapError(() => inputError("invalid-request"))
    )
    yield* verifyGovernedActionEnvelope(input.envelope).pipe(
      Effect.provideService(Crypto.Crypto, cryptoService),
      Effect.mapError(() => inputError("conflicting-action-identity"))
    )
    const envelopeJson = yield* encodeJson("governed-action.encode-envelope", EnvelopeJson, input.envelope)
    const commandDigest = yield* digestGovernedActionTransitionCommand(input.command).pipe(
      Effect.provideService(Crypto.Crypto, cryptoService),
      Effect.mapError(() => new PersistenceOperationError({ operation: "governed-action.digest-command" }))
    )
    const commandJson = yield* encodeJson("governed-action.encode-command", CommandJson, input.command)
    const causeJson = yield* encodeJson("governed-action.encode-cause", CauseJson, input.cause)
    const occurredAt = yield* encodeTimestamp("governed-action.encode-occurred-at", input.occurredAt)
    const preparedCompanion = yield* prepareCompanion(cryptoService)(input.companion)
    return yield* Effect.gen(function*() {
      // Exact replay must remain the first SQL statement and precede head validation.
      const replayRaw = yield* sql`SELECT
        transition_record.transition_id AS transitionId,
        transition_record.previous_transition_id AS previousTransitionId,
        transition_record.command_id AS commandId,
        transition_record.command_digest AS commandDigest,
        transition_record.transition_digest AS transitionDigest,
        transition_record.transition_json AS transitionJson,
        denial_policy.policy_evaluation_digest AS linkedPolicyEvaluationDigest,
        audit.audit_event_id AS auditEventId, audit.event_kind AS auditEventKind,
        audit.cause_kind AS auditCauseKind, audit.actor_id AS auditActorId,
        audit.session_id AS auditSessionId, audit.job_id AS auditJobId,
        audit.system_component AS auditSystemComponent, audit.causation_id AS auditCausationId,
        audit.correlation_id AS auditCorrelationId, audit.payload_digest AS auditPayloadDigest,
        audit.payload_json AS auditPayloadJson, audit.occurred_at AS auditOccurredAt,
        authorization.workspace_id AS authorizationWorkspaceId,
        authorization.action_id AS authorizationActionId,
        authorization.authorization_id AS authorizationId,
        authorization.session_id AS authorizationSessionId,
        authorization.envelope_digest AS authorizationEnvelopeDigest,
        authorization.authorization_digest AS authorizationDigest,
        authorization.authorization_json AS authorizationJson,
        authorization.authorized_at AS authorizationAuthorizedAt,
        authorization.expires_at AS authorizationExpiresAt,
        evaluation.evaluation_digest AS evaluationDigest,
        evaluation.evaluation_json AS evaluationJson,
        attempt.attempt_digest AS attemptDigest, attempt.attempt_json AS attemptJson,
        (SELECT COUNT(*) FROM (
          SELECT 1 FROM governed_action_policy_evaluations unowned_evaluation
          WHERE unowned_evaluation.workspace_id = transition_record.workspace_id
            AND unowned_evaluation.action_id = transition_record.action_id
            AND NOT EXISTS (
              SELECT 1 FROM governed_action_attempts owning_attempt
              WHERE owning_attempt.workspace_id = unowned_evaluation.workspace_id
                AND owning_attempt.action_id = unowned_evaluation.action_id
                AND owning_attempt.policy_evaluation_digest = unowned_evaluation.evaluation_digest
            )
            AND NOT EXISTS (
              SELECT 1 FROM governed_action_denial_policy_evaluations owning_denial
              WHERE owning_denial.workspace_id = unowned_evaluation.workspace_id
                AND owning_denial.action_id = unowned_evaluation.action_id
                AND owning_denial.policy_evaluation_digest = unowned_evaluation.evaluation_digest
            )
          LIMIT 2
        )) AS unownedEvaluationCount
      FROM governed_action_transitions transition_record
      LEFT JOIN audit_events audit ON audit.workspace_id = transition_record.workspace_id
       AND audit.action_id = transition_record.action_id AND audit.transition_id = transition_record.transition_id
      LEFT JOIN governed_action_authorizations authorization
        ON authorization.workspace_id = transition_record.workspace_id
       AND authorization.action_id = transition_record.action_id
       AND authorization.authorization_id = transition_record.authorization_id
      LEFT JOIN governed_action_attempts attempt ON attempt.workspace_id = transition_record.workspace_id
       AND attempt.action_id = transition_record.action_id AND attempt.attempt_id = transition_record.attempt_id
      LEFT JOIN governed_action_denial_policy_evaluations denial_policy
        ON denial_policy.workspace_id = transition_record.workspace_id
       AND denial_policy.action_id = transition_record.action_id
       AND denial_policy.transition_id = transition_record.transition_id
      LEFT JOIN governed_action_policy_evaluations evaluation
        ON evaluation.workspace_id = transition_record.workspace_id
       AND evaluation.action_id = transition_record.action_id
       AND evaluation.evaluation_digest = COALESCE(
         attempt.policy_evaluation_digest,
         denial_policy.policy_evaluation_digest
       )
      WHERE transition_record.workspace_id = ${input.envelope.workspaceId}
        AND transition_record.action_id = ${input.envelope.actionId}
        AND (transition_record.command_id = ${input.commandId}
          OR transition_record.transition_id = ${input.transitionId})
      LIMIT 2`
      const replayRows = yield* replay.decodeRows(input, replayRaw).pipe(
        captureMalformedGovernedActionRow(replayRaw)
      )
      const replayResult = yield* replay.resolve(
        input,
        commandDigest,
        commandJson,
        causeJson,
        preparedCompanion,
        replayRows
      ).pipe(captureMalformedGovernedActionRow(replayRows[0] ?? replayRaw))
      if (replayResult !== null) {
        yield* verifyDispatchAuthorization(input, preparedCompanion, "replay")
        return replayResult
      }

      const rootRaw = yield* sql`SELECT
        action.action_id AS actionId, action.plugin_connection_id AS pluginConnectionId,
        action.provider_id AS providerId, action.target_entity_id AS targetEntityId,
        action.idempotency_key AS idempotencyKey, action.envelope_digest AS envelopeDigest,
        action.envelope_json AS envelopeJson, action.state, action.lineage_json AS lineageJson,
        action.lineage_kind AS lineageKind, action.provider_operation_id AS providerOperationId,
        action.reconciliation_key AS reconciliationKey, action.terminal_status AS terminalStatus,
        action.head_transition_id AS headTransitionId, action.head_sequence AS headSequence,
        head.transition_id AS persistedHeadTransitionId, action.updated_at AS updatedAt
      FROM governed_actions action
      LEFT JOIN governed_action_transitions head ON head.workspace_id = action.workspace_id
       AND head.action_id = action.action_id AND head.transition_id = action.head_transition_id
       AND head.sequence = action.head_sequence
      WHERE action.workspace_id = ${input.envelope.workspaceId}
        AND (action.action_id = ${input.envelope.actionId}
          OR (action.plugin_connection_id = ${input.envelope.pluginConnectionId}
            AND action.idempotency_key = ${input.envelope.idempotencyKey}))`
      const rootRows = yield* decodeRootRows(input, rootRaw).pipe(captureMalformedGovernedActionRow(rootRaw))
      if (rootRows.length > 1) return yield* inputError("conflicting-action-identity")
      const root = rootRows[0]

      let currentHead: RootHead | null = null
      if (root === undefined) {
        if (input.command._tag !== "propose" || input.expectedHeadTransitionId !== null) {
          return yield* inputError("conflicting-action-identity")
        }
        yield* sql`INSERT INTO governed_actions (
          workspace_id, action_id, plugin_connection_id, provider_id, target_entity_id,
          idempotency_key, envelope_digest, envelope_json, state, lineage_json,
          lineage_kind, provider_operation_id, reconciliation_key, terminal_status,
          head_transition_id, head_sequence, created_at, updated_at
        ) VALUES (
          ${input.envelope.workspaceId}, ${input.envelope.actionId}, ${input.envelope.pluginConnectionId},
          ${input.envelope.providerId}, ${input.envelope.targetEntityId}, ${input.envelope.idempotencyKey},
          ${input.envelope.envelopeDigest}, ${envelopeJson}, NULL, NULL, NULL, NULL, NULL, NULL,
          NULL, NULL, ${occurredAt}, ${occurredAt})`
      } else {
        yield* verifyRootIdentity(input, envelopeJson, root).pipe(captureMalformedGovernedActionRow(root))
        if (input.command._tag === "propose") return yield* inputError("conflicting-action-identity")
        currentHead = yield* decodeRootHead(input, root).pipe(captureMalformedGovernedActionRow(root))
        if (currentHead.transitionId !== input.expectedHeadTransitionId) return yield* inputError("stale-head")
        if (DateTime.Order(input.occurredAt, currentHead.updatedAt) < 0) {
          return yield* inputError("illegal-transition")
        }
      }

      const nextHead = advanceGovernedActionLifecycle(
        currentHead === null ? null : { state: currentHead.state, lineage: currentHead.lineage },
        input.command
      )
      if (nextHead === null) return yield* inputError("illegal-transition")
      const transition = (yield* makeGovernedActionTransition({
        schemaVersion: 1,
        transitionId: input.transitionId,
        previousTransitionId: currentHead?.transitionId ?? null,
        commandId: input.commandId,
        actionId: input.envelope.actionId,
        workspaceId: input.envelope.workspaceId,
        sequence: (currentHead?.sequence ?? 0) + 1,
        fromState: currentHead?.state ?? null,
        toState: nextHead.state,
        actionEnvelopeDigest: input.envelope.envelopeDigest,
        command: input.command,
        cause: input.cause,
        occurredAt: input.occurredAt,
        causationId: input.causationId,
        correlationId: input.correlationId
      }).pipe(
        Effect.provideService(Crypto.Crypto, cryptoService),
        Effect.mapError(() => inputError("illegal-transition"))
      )).transition
      const transitionJson = yield* encodeJson("governed-action.encode-transition", TransitionJson, transition)
      const transitionDigest = yield* digestGovernedActionTransition(transition).pipe(
        Effect.provideService(Crypto.Crypto, cryptoService),
        Effect.mapError(() => new PersistenceOperationError({ operation: "governed-action.digest-transition" }))
      )
      const lineageJson = yield* encodeJson("governed-action.encode-lineage", LineageJson, nextHead.lineage)
      const command = commandColumns(input.command)
      const cause = causeColumns(input.cause)
      const lineage = lineageColumns(nextHead.lineage)
      const denialPolicyEvaluationDigest = preparedCompanion._tag === "policyDenial"
        ? preparedCompanion.evaluationDigest
        : null

      yield* verifyDispatchAuthorization(input, preparedCompanion, "commit")
      yield* insertCompanion(preparedCompanion)
      yield* sql`INSERT INTO governed_action_transitions (
        workspace_id, action_id, transition_id, previous_transition_id, sequence,
        command_id, command_tag, authorization_id, attempt_id, outcome_source_kind,
        command_provider_operation_id, command_reconciliation_key, command_terminal_status,
        command_unknown_kind, command_digest, transition_digest, envelope_digest,
        from_state, to_state, result_lineage_json, result_lineage_kind,
        result_provider_operation_id, result_reconciliation_key, result_terminal_status,
        cause_kind, cause_actor_id, cause_session_id, cause_job_id, cause_system_component,
        causation_id, correlation_id, transition_json, occurred_at
      ) VALUES (
        ${input.envelope.workspaceId}, ${input.envelope.actionId}, ${input.transitionId},
        ${currentHead?.transitionId ?? null}, ${transition.sequence}, ${input.commandId},
        ${input.command._tag}, ${command.authorizationId}, ${command.attemptId},
        ${command.outcomeSourceKind}, ${command.providerOperationId}, ${command.reconciliationKey},
        ${command.terminalStatus}, ${command.unknownKind}, ${transition.commandDigest},
        ${transitionDigest}, ${input.envelope.envelopeDigest}, ${currentHead?.state ?? null},
        ${nextHead.state}, ${lineageJson}, ${lineage.kind}, ${lineage.providerOperationId},
        ${lineage.reconciliationKey}, ${lineage.terminalStatus}, ${cause.kind}, ${cause.actorId},
        ${cause.sessionId}, ${cause.jobId}, ${cause.systemComponent}, ${input.causationId},
        ${input.correlationId}, ${transitionJson}, ${occurredAt})`
      if (denialPolicyEvaluationDigest !== null) {
        yield* sql`INSERT INTO governed_action_denial_policy_evaluations (
          workspace_id, action_id, transition_id, policy_evaluation_digest
        ) VALUES (
          ${input.envelope.workspaceId}, ${input.envelope.actionId}, ${input.transitionId},
          ${denialPolicyEvaluationDigest}
        )`
      }
      yield* sql`INSERT INTO audit_events (
        workspace_id, action_id, transition_id, audit_event_id, event_kind,
        cause_kind, actor_id, session_id, job_id, system_component, causation_id,
        correlation_id, payload_digest, payload_json, occurred_at
      ) VALUES (
        ${input.envelope.workspaceId}, ${input.envelope.actionId}, ${input.transitionId},
        ${input.auditEventId}, ${nextHead.state}, ${cause.kind}, ${cause.actorId},
        ${cause.sessionId}, ${cause.jobId}, ${cause.systemComponent}, ${input.causationId},
        ${input.correlationId}, ${transitionDigest}, ${transitionJson}, ${occurredAt})`
      yield* sql`UPDATE governed_actions SET
        state = ${nextHead.state}, lineage_json = ${lineageJson}, lineage_kind = ${lineage.kind},
        provider_operation_id = ${lineage.providerOperationId},
        reconciliation_key = ${lineage.reconciliationKey}, terminal_status = ${lineage.terminalStatus},
        head_transition_id = ${input.transitionId}, head_sequence = ${transition.sequence},
        updated_at = ${occurredAt}
      WHERE workspace_id = ${input.envelope.workspaceId} AND action_id = ${input.envelope.actionId}
        AND head_sequence IS ${currentHead?.sequence ?? null}
        AND head_transition_id IS ${currentHead?.transitionId ?? null}
        AND state IS ${currentHead?.state ?? null}`
      const changed = yield* readChanges(sql).pipe(
        Effect.mapError(() => new PersistenceOperationError({ operation: "governed-action.read-changes" }))
      )
      if (changed !== 1) return yield* inputError("stale-head")
      const result: GovernedActionCommitResult = { _tag: "committed", transition }
      return result
    })
  })

  return { commit }
})

/**
 * Private governed-action writer that participates in the caller's current transaction.
 *
 * It never opens a transaction. Execution coordination uses this seam to commit a lifecycle
 * transition and its lease atomically; ordinary repository callers use `makeGovernedActionWrite`.
 */
export const makeGovernedActionTransactionWrite = makeGovernedActionTransactionWriter

const makeGovernedActionWriter = Effect.gen(function*() {
  const database = yield* Database
  const writer = yield* makeGovernedActionTransactionWrite

  const commit = Effect.fn("GovernedActionWriter.commit")(function*(input: GovernedActionCommitInput) {
    return yield* database.transaction(writer.commit(input)).pipe(
      mapPersistenceOperation("governed-action.commit")
    )
  })

  return { commit }
})

/** Private transactional governed-action writer used by the repository facade. */
export const makeGovernedActionWrite = makeGovernedActionWriter
