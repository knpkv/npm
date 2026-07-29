import { type RenderedSql, renderGovernedActionIdempotencyQuery } from "@knpkv/control-center-sql"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Equal from "effect/Equal"
import * as Schema from "effect/Schema"

import {
  advanceGovernedActionLifecycle,
  governedActionAuthorityMismatches,
  governedActionAuthorizationMatchesTransition,
  governedActionAuthorizationMismatches
} from "../../../../domain/governedAction/index.js"
import { GovernedActionId } from "../../../../domain/identifiers.js"
import { UtcTimestamp } from "../../../../domain/utcTimestamp.js"
import { digestGovernedActionPolicyEvaluation } from "../../../governance/governedActionDigests.js"
import { Database } from "../../Database.js"
import { PersistedRecordError, RecordNotFoundError } from "../../errors.js"
import {
  decodeGovernedActionAttemptRow,
  decodeGovernedActionAuditEventRow,
  decodeGovernedActionAuthorizationRow,
  decodeGovernedActionPolicyEvaluationRow,
  decodeGovernedActionRow,
  decodeGovernedActionTransitionRow,
  encodeGovernedActionTransitionJson,
  type GovernedActionQuarantineReasonCode,
  type GovernedActionQuarantineRecordKind,
  governedActionRecordError
} from "./codec.js"
import type {
  GovernedActionIdempotencyReadInput,
  GovernedActionReadInput,
  GovernedActionRecord,
  GovernedActionTargetReadInput
} from "./contract.js"
import { captureMalformedGovernedActionRow } from "./quarantine.js"
import {
  GovernedActionAttemptRow,
  GovernedActionAuditEventRow,
  GovernedActionAuthorizationRow,
  GovernedActionPolicyEvaluationRow,
  GovernedActionRow,
  GovernedActionTransitionRow
} from "./rows.js"

const MAXIMUM_GOVERNED_ACTION_TRANSITIONS = 1_000
const TERMINAL_TARGET_PAGE_SIZE = 100

const GovernedActionTargetCandidateIdentity = Schema.Struct({
  actionId: GovernedActionId,
  sortAt: UtcTimestamp
})

const malformed = (
  request: GovernedActionReadInput,
  recordKind: GovernedActionQuarantineRecordKind,
  diagnosticCode: GovernedActionQuarantineReasonCode,
  recordKey: string = request.actionId
) =>
  governedActionRecordError({
    workspaceId: request.workspaceId,
    recordKind,
    recordKey,
    diagnosticCode
  })

const decodeRawRow = <SchemaType extends Schema.Top>(
  request: GovernedActionReadInput,
  schema: SchemaType,
  raw: unknown,
  recordKind: GovernedActionQuarantineRecordKind,
  diagnosticCode: GovernedActionQuarantineReasonCode
) =>
  Schema.decodeUnknownEffect(schema)(raw).pipe(
    Effect.mapError(() => malformed(request, recordKind, diagnosticCode)),
    captureMalformedGovernedActionRow(raw)
  )

const decodeRows = <SchemaType extends Schema.Top>(
  request: GovernedActionReadInput,
  schema: SchemaType,
  rows: ReadonlyArray<unknown>,
  recordKind: GovernedActionQuarantineRecordKind,
  diagnosticCode: GovernedActionQuarantineReasonCode
) => Effect.forEach(rows, (row) => decodeRawRow(request, schema, row, recordKind, diagnosticCode))

const failMalformed = (
  request: GovernedActionReadInput,
  recordKind: GovernedActionQuarantineRecordKind,
  diagnosticCode: GovernedActionQuarantineReasonCode,
  row: unknown,
  recordKey?: string
) => Effect.fail(malformed(request, recordKind, diagnosticCode, recordKey)).pipe(captureMalformedGovernedActionRow(row))

/** Order verified target candidates by terminal observation and enforce local approval provenance. @internal */
export const selectLatestTerminalByTarget = (
  request: GovernedActionTargetReadInput,
  candidates: ReadonlyArray<GovernedActionRecord>
): ReadonlyArray<GovernedActionRecord> =>
  candidates.filter(({ authorization, envelope, head }) =>
    envelope.proposal.request.actionKind === request.actionKind &&
    (
      request.actionKind !== "record-approval" ||
      (
        authorization !== null &&
        head.lineage._tag === "terminal" &&
        head.lineage.receipt.observationBasis === "authorization" &&
        DateTime.Order(head.lineage.receipt.observedAt, authorization.authorizedAt) === 0
      )
    )
  ).sort((left, right) => {
    if (left.head.lineage._tag !== "terminal" || right.head.lineage._tag !== "terminal") return 0
    const newestFirst = DateTime.Order(
      right.head.lineage.receipt.observedAt,
      left.head.lineage.receipt.observedAt
    )
    return newestFirst !== 0
      ? newestFirst
      : right.envelope.actionId.localeCompare(left.envelope.actionId)
  }).slice(0, request.limit)

/** Decide whether verified candidates satisfy a bounded target read without another SQL page. @internal */
export const hasEnoughTerminalByTargetCandidates = (
  request: GovernedActionTargetReadInput,
  candidates: ReadonlyArray<GovernedActionRecord>
): boolean => selectLatestTerminalByTarget(request, candidates).length >= request.limit

/** @internal Decode the unique action identity returned by an idempotency lookup. */
export const decodeGovernedActionIdempotencyRows = Effect.fn(
  "GovernedActionReader.decodeIdempotencyRows"
)(function*(
  request: GovernedActionIdempotencyReadInput,
  rows: ReadonlyArray<unknown>
) {
  if (rows.length === 0) {
    return yield* new RecordNotFoundError({
      workspaceId: request.workspaceId,
      recordKind: "governed-action",
      recordKey: request.idempotencyKey
    })
  }
  if (rows.length !== 1) {
    return yield* new PersistedRecordError({
      workspaceId: request.workspaceId,
      recordKind: "governed-action",
      recordKey: request.idempotencyKey,
      diagnosticCode: "governed-action-identity-mismatch"
    })
  }
  const decoded = yield* Schema.decodeUnknownEffect(
    Schema.Struct({ actionId: GovernedActionId })
  )(rows[0]).pipe(
    Effect.mapError(() =>
      new PersistedRecordError({
        workspaceId: request.workspaceId,
        recordKind: "governed-action",
        recordKey: request.pluginConnectionId,
        diagnosticCode: "governed-action-schema-invalid"
      })
    )
  )
  return decoded.actionId
})

/** Build verified governed-action aggregate reads over one transaction-local SQL client. */
export const makeGovernedActionRead = Effect.gen(function*() {
  const { sql } = yield* Database
  const run = (plan: RenderedSql) => sql.unsafe<Record<string, unknown>>(plan.sql, [...plan.params])

  const read = Effect.fn("GovernedActionReader.read")(function*(request: GovernedActionReadInput) {
    const rootRows = yield* sql<Record<string, unknown>>`SELECT
      workspace_id AS workspaceId, action_id AS actionId,
      plugin_connection_id AS pluginConnectionId, provider_id AS providerId,
      target_entity_id AS targetEntityId, idempotency_key AS idempotencyKey,
      envelope_digest AS envelopeDigest, envelope_json AS envelopeJson,
      state, lineage_json AS lineageJson, lineage_kind AS lineageKind,
      provider_operation_id AS providerOperationId,
      reconciliation_key AS reconciliationKey, terminal_status AS terminalStatus,
      head_transition_id AS headTransitionId, head_sequence AS headSequence,
      created_at AS createdAt, updated_at AS updatedAt
    FROM governed_actions
    WHERE workspace_id = ${request.workspaceId} AND action_id = ${request.actionId}`
    if (rootRows.length === 0) {
      return yield* new RecordNotFoundError({
        workspaceId: request.workspaceId,
        recordKind: "governed-action",
        recordKey: request.actionId
      })
    }
    if (rootRows.length !== 1) {
      return yield* new PersistedRecordError({
        workspaceId: request.workspaceId,
        recordKind: "governed-action",
        recordKey: request.actionId,
        diagnosticCode: "governed-action-identity-mismatch"
      })
    }
    const rootRow = rootRows[0]
    const decodedRootRow = yield* decodeRawRow(
      request,
      GovernedActionRow,
      rootRow,
      "governed-action",
      "governed-action-schema-invalid"
    )
    const root = yield* decodeGovernedActionRow(decodedRootRow).pipe(
      captureMalformedGovernedActionRow(rootRow)
    )
    if (root.head === null) {
      return yield* failMalformed(
        request,
        "governed-action",
        "governed-action-head-mismatch",
        rootRow
      )
    }

    const transitionRawRows = yield* sql<Record<string, unknown>>`SELECT
      workspace_id AS workspaceId, action_id AS actionId, transition_id AS transitionId,
      previous_transition_id AS previousTransitionId, sequence, command_id AS commandId,
      command_tag AS commandTag, authorization_id AS authorizationId, attempt_id AS attemptId,
      (SELECT ownership.policy_evaluation_digest
        FROM governed_action_denial_policy_evaluations ownership
        WHERE ownership.workspace_id = governed_action_transitions.workspace_id
          AND ownership.action_id = governed_action_transitions.action_id
          AND ownership.transition_id = governed_action_transitions.transition_id
      ) AS policyEvaluationDigest,
      outcome_source_kind AS outcomeSourceKind,
      command_provider_operation_id AS commandProviderOperationId,
      command_reconciliation_key AS commandReconciliationKey,
      command_terminal_status AS commandTerminalStatus, command_unknown_kind AS commandUnknownKind,
      command_digest AS commandDigest, transition_digest AS transitionDigest,
      envelope_digest AS envelopeDigest, from_state AS fromState, to_state AS toState,
      result_lineage_json AS resultLineageJson, result_lineage_kind AS resultLineageKind,
      result_provider_operation_id AS resultProviderOperationId,
      result_reconciliation_key AS resultReconciliationKey,
      result_terminal_status AS resultTerminalStatus, cause_kind AS causeKind,
      cause_actor_id AS causeActorId, cause_session_id AS causeSessionId,
      cause_job_id AS causeJobId, cause_system_component AS causeSystemComponent,
      causation_id AS causationId, correlation_id AS correlationId,
      transition_json AS transitionJson, occurred_at AS occurredAt
    FROM governed_action_transitions
    WHERE workspace_id = ${request.workspaceId} AND action_id = ${request.actionId}
    ORDER BY sequence
    LIMIT ${MAXIMUM_GOVERNED_ACTION_TRANSITIONS + 1}`
    if (
      transitionRawRows.length === 0 ||
      transitionRawRows.length > MAXIMUM_GOVERNED_ACTION_TRANSITIONS
    ) {
      return yield* failMalformed(
        request,
        "governed-action-transition",
        "governed-action-chain-invalid",
        rootRow
      )
    }
    const transitionRows = yield* decodeRows(
      request,
      GovernedActionTransitionRow,
      transitionRawRows,
      "governed-action-transition",
      "governed-action-transition-schema-invalid"
    )
    const decodedTransitions = yield* Effect.forEach(
      transitionRows,
      (row, index) =>
        decodeGovernedActionTransitionRow(row).pipe(
          captureMalformedGovernedActionRow(transitionRawRows[index])
        )
    )

    const auditRawRows = yield* sql<Record<string, unknown>>`SELECT
      workspace_id AS workspaceId, action_id AS actionId, transition_id AS transitionId,
      audit_event_id AS auditEventId, event_kind AS eventKind, cause_kind AS causeKind,
      actor_id AS actorId, session_id AS sessionId, job_id AS jobId,
      system_component AS systemComponent, causation_id AS causationId,
      correlation_id AS correlationId, payload_digest AS payloadDigest,
      payload_json AS payloadJson, occurred_at AS occurredAt
    FROM audit_events
    WHERE workspace_id = ${request.workspaceId} AND action_id = ${request.actionId}
    ORDER BY occurred_at, transition_id`
    const auditRows = yield* decodeRows(
      request,
      GovernedActionAuditEventRow,
      auditRawRows,
      "governed-action-audit",
      "governed-action-audit-mismatch"
    )
    const decodedAudits = yield* Effect.forEach(
      auditRows,
      (row, index) =>
        decodeGovernedActionAuditEventRow(row).pipe(
          captureMalformedGovernedActionRow(auditRawRows[index])
        )
    )
    if (decodedAudits.length !== decodedTransitions.length) {
      return yield* failMalformed(
        request,
        "governed-action-audit",
        "governed-action-audit-mismatch",
        transitionRawRows.at(-1) ?? rootRow
      )
    }

    let lifecycle: GovernedActionRecord["head"] | null = null
    let previousTransitionId: GovernedActionRecord["headTransition"]["transitionId"] | null = null
    for (const [index, decoded] of decodedTransitions.entries()) {
      const transition = decoded.transition
      const expectedSequence = index + 1
      if (
        transition.sequence !== expectedSequence ||
        transition.previousTransitionId !== previousTransitionId ||
        transition.workspaceId !== request.workspaceId ||
        transition.actionId !== request.actionId ||
        transition.actionEnvelopeDigest !== root.envelope.envelopeDigest
      ) {
        return yield* failMalformed(
          request,
          "governed-action-transition",
          "governed-action-chain-invalid",
          transitionRawRows[index]
        )
      }
      const nextLifecycle = advanceGovernedActionLifecycle(lifecycle, transition.command)
      if (nextLifecycle === null || !Equal.equals(nextLifecycle, decoded.resultHead)) {
        return yield* failMalformed(
          request,
          "governed-action-transition",
          "governed-action-chain-invalid",
          transitionRawRows[index]
        )
      }
      const auditTransition = decodedAudits.find(
        (candidate) => candidate.transitionId === transition.transitionId
      )
      if (
        auditTransition === undefined ||
        (yield* encodeGovernedActionTransitionJson(auditTransition)) !==
          (yield* encodeGovernedActionTransitionJson(transition))
      ) {
        return yield* failMalformed(
          request,
          "governed-action-audit",
          "governed-action-audit-mismatch",
          auditRawRows[index] ?? transitionRawRows[index]
        )
      }
      lifecycle = nextLifecycle
      previousTransitionId = transition.transitionId
    }

    const finalTransition = decodedTransitions.at(-1)?.transition
    if (
      finalTransition === undefined ||
      lifecycle === null ||
      root.head.transitionId !== finalTransition.transitionId ||
      root.head.sequence !== finalTransition.sequence ||
      !Equal.equals(root.head.lifecycle, lifecycle) ||
      DateTime.Order(root.head.updatedAt, finalTransition.occurredAt) !== 0
    ) {
      return yield* failMalformed(
        request,
        "governed-action",
        "governed-action-head-mismatch",
        rootRow
      )
    }

    const authorizationRawRows = yield* sql<Record<string, unknown>>`SELECT
      workspace_id AS workspaceId, action_id AS actionId, authorization_id AS authorizationId,
      session_id AS sessionId, envelope_digest AS envelopeDigest,
      authorization_digest AS authorizationDigest, authorization_json AS authorizationJson,
      authorized_at AS authorizedAt, expires_at AS expiresAt
    FROM governed_action_authorizations
    WHERE workspace_id = ${request.workspaceId} AND action_id = ${request.actionId}
    LIMIT 2`
    const policyRawRows = yield* sql<Record<string, unknown>>`SELECT
      workspace_id AS workspaceId, action_id AS actionId, evaluation_digest AS evaluationDigest,
      evaluation_json AS evaluationJson, decision, evaluated_at AS evaluatedAt
    FROM governed_action_policy_evaluations
    WHERE workspace_id = ${request.workspaceId} AND action_id = ${request.actionId}
    LIMIT 2`
    const attemptRawRows = yield* sql<Record<string, unknown>>`SELECT
      workspace_id AS workspaceId, action_id AS actionId, attempt_id AS attemptId,
      authorization_id AS authorizationId, policy_evaluation_digest AS policyEvaluationDigest,
      attempt_digest AS attemptDigest, attempt_number AS attemptNumber,
      attempt_json AS attemptJson, started_at AS startedAt
    FROM governed_action_attempts
    WHERE workspace_id = ${request.workspaceId} AND action_id = ${request.actionId}
    LIMIT 2`
    if (authorizationRawRows.length > 1 || policyRawRows.length > 1 || attemptRawRows.length > 1) {
      return yield* failMalformed(
        request,
        "governed-action",
        "governed-action-companion-invalid",
        authorizationRawRows[1] ?? policyRawRows[1] ?? attemptRawRows[1] ?? rootRow
      )
    }

    const authorizationRow = authorizationRawRows[0]
    const policyRow = policyRawRows[0]
    const attemptRow = attemptRawRows[0]
    const authorization = authorizationRow === undefined
      ? null
      : yield* decodeRawRow(
        request,
        GovernedActionAuthorizationRow,
        authorizationRow,
        "governed-action-authorization",
        "governed-action-companion-invalid"
      ).pipe(
        Effect.flatMap(decodeGovernedActionAuthorizationRow),
        captureMalformedGovernedActionRow(authorizationRow)
      )
    const policyEvaluation = policyRow === undefined
      ? null
      : yield* decodeRawRow(
        request,
        GovernedActionPolicyEvaluationRow,
        policyRow,
        "governed-action-policy-evaluation",
        "governed-action-companion-invalid"
      ).pipe(
        Effect.flatMap(decodeGovernedActionPolicyEvaluationRow),
        captureMalformedGovernedActionRow(policyRow)
      )
    const attempt = attemptRow === undefined
      ? null
      : yield* decodeRawRow(
        request,
        GovernedActionAttemptRow,
        attemptRow,
        "governed-action-attempt",
        "governed-action-companion-invalid"
      ).pipe(
        Effect.flatMap(decodeGovernedActionAttemptRow),
        captureMalformedGovernedActionRow(attemptRow)
      )

    const authorizeTransition = decodedTransitions.find(({ transition }) => transition.command._tag === "authorize")
      ?.transition
    const startTransition = decodedTransitions.find(({ transition }) => transition.command._tag === "start")
      ?.transition
    const denialTransitionIndex = decodedTransitions.findIndex(
      ({ transition }) => transition.command._tag === "deny"
    )
    const denialPolicyEvaluationDigest = denialTransitionIndex < 0
      ? null
      : (transitionRows[denialTransitionIndex]?.policyEvaluationDigest ?? null)
    const policyEvaluationDigest = policyEvaluation === null
      ? null
      : yield* digestGovernedActionPolicyEvaluation(policyEvaluation).pipe(
        Effect.mapError(() =>
          malformed(
            request,
            "governed-action-policy-evaluation",
            "governed-action-companion-invalid"
          )
        )
      )
    const authorizationMatchesEnvelope = authorization === null ||
      governedActionAuthorizationMismatches({
          envelope: root.envelope,
          authorization
        }).length === 0
    const authorizationMatchesTransition = authorization === null ||
      (authorizeTransition !== undefined &&
        governedActionAuthorizationMatchesTransition(authorization, authorizeTransition))
    const policyMatchesEnvelope = policyEvaluation === null ||
      (Equal.equals(policyEvaluation.policy, root.envelope.policy) &&
        policyEvaluation.payloadDigest === root.envelope.proposal.payloadDigest &&
        policyEvaluation.evidenceSetDigest === root.envelope.evidenceSetDigest &&
        policyEvaluation.expectedRevision === root.envelope.proposal.request.expectedRevision)
    const attemptMatchesEnvelope = attempt === null ||
      (attempt.pluginConnectionId === root.envelope.pluginConnectionId &&
        attempt.idempotencyKey === root.envelope.idempotencyKey &&
        attempt.actionEnvelopeDigest === root.envelope.envelopeDigest &&
        attempt.expectedRevision === root.envelope.proposal.request.expectedRevision)
    const expectedPolicyEvaluationDigest = attempt?.policyEvaluationDigest ?? denialPolicyEvaluationDigest
    const policyHasOwningTransition = policyEvaluation === null
      ? expectedPolicyEvaluationDigest === null
      : expectedPolicyEvaluationDigest === policyEvaluationDigest &&
        (attempt !== null || policyEvaluation.decision === "denied")
    const dispatchAuthorityMatches = attempt === null ||
      (authorization !== null && policyEvaluation !== null &&
        DateTime.Order(policyEvaluation.evaluatedAt, attempt.startedAt) === 0 &&
        governedActionAuthorityMismatches({
            envelope: root.envelope,
            authorization,
            attempt,
            evaluatedAt: attempt.startedAt
          }).length === 0)
    if (
      !authorizationMatchesEnvelope ||
      !authorizationMatchesTransition ||
      (authorization === null) !== (authorizeTransition === undefined)
    ) {
      return yield* failMalformed(
        request,
        "governed-action-authorization",
        "governed-action-companion-invalid",
        authorizationRow ?? rootRow,
        authorization?.authorizationId
      )
    }
    if (
      !policyMatchesEnvelope ||
      !attemptMatchesEnvelope ||
      !policyHasOwningTransition ||
      !dispatchAuthorityMatches ||
      (attempt === null) !== (startTransition === undefined) ||
      (attempt !== null &&
        (startTransition?.command._tag !== "start" ||
          startTransition.command.attemptId !== attempt.attemptId ||
          authorization === null ||
          policyEvaluation === null ||
          attempt.authorizationId !== authorization.authorizationId ||
          attempt.policyEvaluationDigest !== policyEvaluationDigest))
    ) {
      return yield* failMalformed(
        request,
        "governed-action",
        "governed-action-companion-invalid",
        attemptRow ?? authorizationRow ?? policyRow ?? rootRow
      )
    }

    return {
      envelope: root.envelope,
      head: lifecycle,
      headTransition: finalTransition,
      history: decodedTransitions.map(({ transition }) => transition),
      authorization,
      policyEvaluation,
      attempt
    } satisfies GovernedActionRecord
  })

  const readByIdempotencyKey = Effect.fn(
    "GovernedActionReader.readByIdempotencyKey"
  )(function*(request: GovernedActionIdempotencyReadInput) {
    const rows = yield* run(renderGovernedActionIdempotencyQuery(request))
    const actionId = yield* decodeGovernedActionIdempotencyRows(request, rows).pipe(
      Effect.catchIf(
        (failure): failure is PersistedRecordError =>
          Schema.is(PersistedRecordError)(failure) &&
          failure.diagnosticCode === "governed-action-schema-invalid",
        (failure) => Effect.fail(failure).pipe(captureMalformedGovernedActionRow(rows[0]))
      )
    )
    return yield* read({ workspaceId: request.workspaceId, actionId })
  })

  const readLatestTerminalByTarget = Effect.fn(
    "GovernedActionReader.readLatestTerminalByTarget"
  )(function*(request: GovernedActionTargetReadInput) {
    const candidates: Array<GovernedActionRecord> = []
    let cursor: typeof GovernedActionTargetCandidateIdentity.Type | null = null
    while (!hasEnoughTerminalByTargetCandidates(request, candidates)) {
      const rows: ReadonlyArray<Record<string, unknown>> = request.actionKind === "record-approval"
        ? cursor === null
          ? yield* sql<Record<string, unknown>>`SELECT
              action.action_id AS actionId,
              COALESCE(authorization.authorized_at, action.updated_at) AS sortAt
            FROM governed_actions AS action
            LEFT JOIN governed_action_authorizations AS authorization
              ON authorization.workspace_id = action.workspace_id
              AND authorization.action_id = action.action_id
            WHERE action.workspace_id = ${request.workspaceId}
              AND action.provider_id = ${request.providerId}
              AND action.target_entity_id = ${request.targetEntityId}
              AND action.terminal_status = 'succeeded'
            ORDER BY
              COALESCE(authorization.authorized_at, action.updated_at) DESC,
              action.action_id DESC
            LIMIT ${TERMINAL_TARGET_PAGE_SIZE}`
          : yield* sql<Record<string, unknown>>`SELECT
              action.action_id AS actionId,
              COALESCE(authorization.authorized_at, action.updated_at) AS sortAt
            FROM governed_actions AS action
            LEFT JOIN governed_action_authorizations AS authorization
              ON authorization.workspace_id = action.workspace_id
              AND authorization.action_id = action.action_id
            WHERE action.workspace_id = ${request.workspaceId}
              AND action.provider_id = ${request.providerId}
              AND action.target_entity_id = ${request.targetEntityId}
              AND action.terminal_status = 'succeeded'
              AND (
                COALESCE(authorization.authorized_at, action.updated_at) < ${DateTime.formatIso(cursor.sortAt)}
                OR (
                  COALESCE(authorization.authorized_at, action.updated_at) = ${DateTime.formatIso(cursor.sortAt)}
                  AND action.action_id < ${cursor.actionId}
                )
              )
            ORDER BY
              COALESCE(authorization.authorized_at, action.updated_at) DESC,
              action.action_id DESC
            LIMIT ${TERMINAL_TARGET_PAGE_SIZE}`
        : cursor === null
        ? yield* sql<Record<string, unknown>>`SELECT
            action_id AS actionId, updated_at AS sortAt
          FROM governed_actions
          WHERE workspace_id = ${request.workspaceId}
            AND provider_id = ${request.providerId}
            AND target_entity_id = ${request.targetEntityId}
            AND terminal_status = 'succeeded'
          ORDER BY updated_at DESC, action_id DESC
          LIMIT ${TERMINAL_TARGET_PAGE_SIZE}`
        : yield* sql<Record<string, unknown>>`SELECT
            action_id AS actionId, updated_at AS sortAt
          FROM governed_actions
          WHERE workspace_id = ${request.workspaceId}
            AND provider_id = ${request.providerId}
            AND target_entity_id = ${request.targetEntityId}
            AND terminal_status = 'succeeded'
            AND (
              updated_at < ${DateTime.formatIso(cursor.sortAt)}
              OR (
                updated_at = ${DateTime.formatIso(cursor.sortAt)}
                AND action_id < ${cursor.actionId}
              )
            )
          ORDER BY updated_at DESC, action_id DESC
          LIMIT ${TERMINAL_TARGET_PAGE_SIZE}`
      const identities: ReadonlyArray<typeof GovernedActionTargetCandidateIdentity.Type> = yield* Schema
        .decodeUnknownEffect(
          Schema.Array(GovernedActionTargetCandidateIdentity).check(
            Schema.isMaxLength(TERMINAL_TARGET_PAGE_SIZE)
          )
        )(rows).pipe(
          Effect.mapError(() =>
            new PersistedRecordError({
              workspaceId: request.workspaceId,
              recordKind: "governed-action",
              recordKey: request.targetEntityId,
              diagnosticCode: "governed-action-schema-invalid"
            })
          )
        )
      const verifiedPage = yield* Effect.forEach(
        identities,
        ({ actionId }) => read({ workspaceId: request.workspaceId, actionId })
      )
      for (const candidate of verifiedPage) candidates.push(candidate)
      if (identities.length < TERMINAL_TARGET_PAGE_SIZE) break
      cursor = identities[identities.length - 1] ?? null
    }
    return selectLatestTerminalByTarget(request, candidates)
  })

  return { read, readByIdempotencyKey, readLatestTerminalByTarget }
})
