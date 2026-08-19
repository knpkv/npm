import * as Clock from "effect/Clock"
import * as Crypto from "effect/Crypto"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"

import {
  GovernedActionAttemptV1,
  GovernedActionCommandId,
  GovernedActionPluginConnectionAuthorityDigest,
  GovernedActionPluginConnectionRevision,
  type GovernedActionState,
  GovernedActionTargetSnapshotV1
} from "../../../../domain/governedAction/index.js"
import {
  DomainEventId,
  EntityId,
  GovernedActionAttemptId,
  GovernedActionTransitionId
} from "../../../../domain/identifiers.js"
import { AuthorizedPluginActionV1 } from "../../../../domain/plugins/actions.js"
import { Release } from "../../../../domain/release.js"
import type { UtcTimestamp } from "../../../../domain/utcTimestamp.js"
import { digestReleaseSourceRevisions } from "../../../application/releasePublicationMetadata.js"
import { Database } from "../../../persistence/Database.js"
import { GovernedActionCommitInput } from "../../../persistence/repositories/governed-action/contract.js"
import { makeGovernedActionTransaction } from "../../../persistence/repositories/governed-action/transaction.js"
import { makeGovernedActionTransactionWrite } from "../../../persistence/repositories/governed-action/write.js"
import type { SqlRow } from "../../../persistence/repositories/sqlRow.js"
import { PluginRuntimeAuthoritySource } from "../../../plugins/internal/PluginRuntimeAuthoritySource.js"
import { verifyGovernedActionDispatchAuthority } from "../../governedActionAuthority.js"
import { digestGovernedActionPolicyEvaluation } from "../../governedActionDigests.js"
import type { GovernedActionBeginResult, GovernedActionExecutionStoreV1 } from "../GovernedActionExecutionStore.js"
import { GovernedActionExecutionStoreError } from "../GovernedActionExecutionStore.js"
import { GovernedActionPolicyEvaluator } from "../GovernedActionPolicyEvaluator.js"
import { makeGovernedActionCurrentEvidenceReader } from "./current-evidence.js"
import { makeGovernedActionCurrentSessionReader } from "./current-session.js"
import { makeGovernedActionCurrentTargetReader } from "./current-target.js"
import { makeGovernedActionExecutionPreparationReader } from "./preparation.js"
import { digestGovernedActionPreparationToken, issueGovernedActionPermitToken } from "./tokens.js"

const DISPATCH_WINDOW_SECONDS = 15
const LEASE_GRACE_SECONDS = 30
const RECOVERY_SAFETY_SECONDS = 60
const AttemptCountRow = Schema.Struct({
  count: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))
})
const CurrentReleaseSnapshotRow = Schema.Struct({
  snapshotJson: Schema.String.check(Schema.isNonEmpty())
})

const inactive = (state: GovernedActionState): GovernedActionBeginResult => ({
  _tag: "inactive",
  state
})

const storeFailure = <UnparsedInput>(failure: UnparsedInput): GovernedActionExecutionStoreError => {
  if (Schema.is(GovernedActionExecutionStoreError)(failure)) return failure
  if (Predicate.isTagged("PluginRuntimeAuthorityUnavailable")(failure)) {
    return new GovernedActionExecutionStoreError({ operation: "begin", reason: "authority-changed" })
  }
  if (Predicate.isTagged("RecordNotFoundError")(failure)) {
    return new GovernedActionExecutionStoreError({ operation: "begin", reason: "authority-changed" })
  }
  if (Predicate.isTagged("PersistedRecordError")(failure)) {
    return new GovernedActionExecutionStoreError({ operation: "begin", reason: "invalid-record" })
  }
  if (
    Predicate.isTagged("GovernedActionAuthorityRejected")(failure) ||
    Predicate.isTagged("GovernedActionCurrentEvidenceRejected")(failure) ||
    Predicate.isTagged("GovernedActionPolicyBindingUnavailable")(failure)
  ) {
    return new GovernedActionExecutionStoreError({ operation: "begin", reason: "authority-changed" })
  }
  if (Predicate.isTagged("GovernedActionInputError")(failure)) {
    return new GovernedActionExecutionStoreError({ operation: "begin", reason: "conflict" })
  }
  return new GovernedActionExecutionStoreError({ operation: "begin", reason: "persistence-unavailable" })
}

const hasReconciliation = (current: {
  readonly negotiated: {
    readonly capabilities: ReadonlyArray<{ readonly capabilityId: string; readonly version: number }>
    readonly descriptor: {
      readonly capabilities: ReadonlyArray<{
        readonly capabilityId: string
        readonly supportedVersions: ReadonlyArray<number>
      }>
    }
  }
}): boolean => {
  const negotiated = current.negotiated.capabilities.find(
    ({ capabilityId }) => capabilityId === "action.reconcile"
  )
  const offered = current.negotiated.descriptor.capabilities.find(
    ({ capabilityId }) => capabilityId === "action.reconcile"
  )
  return negotiated?.version === 1 && offered?.supportedVersions.includes(1) === true
}

const earlier = (left: UtcTimestamp, right: UtcTimestamp): UtcTimestamp =>
  DateTime.Order(left, right) <= 0 ? left : right

/** Convert a preparation capability into durable dispatch intent and a one-use permit. */
export const makeGovernedActionExecutionBegin = Effect.gen(function*() {
  const { sql } = yield* Database
  const clock = yield* Clock.Clock
  const cryptoService = yield* Crypto.Crypto
  const runtimeAuthority = yield* PluginRuntimeAuthoritySource
  const policy = yield* GovernedActionPolicyEvaluator
  const transaction = yield* makeGovernedActionTransaction
  const writer = yield* makeGovernedActionTransactionWrite
  const preparations = yield* makeGovernedActionExecutionPreparationReader
  const sessions = yield* makeGovernedActionCurrentSessionReader
  const targets = yield* makeGovernedActionCurrentTargetReader
  const evidence = yield* makeGovernedActionCurrentEvidenceReader

  const begin: GovernedActionExecutionStoreV1["begin"] = Effect.fn(
    "GovernedActionExecutionBegin.begin"
  )(function*(input) {
    const preparationDigest = yield* digestGovernedActionPreparationToken(input.preparationToken).pipe(
      Effect.provideService(Crypto.Crypto, cryptoService),
      Effect.mapError(storeFailure)
    )
    return yield* runtimeAuthority.transactCurrent(
      {
        scope: input.scope,
        runtimeAuthorityToken: input.runtimeAuthorityToken
      },
      (current) =>
        Effect.gen(function*() {
          const now = DateTime.makeUnsafe(yield* clock.currentTimeMillis)
          const preparation = yield* preparations.read({
            workspaceId: input.scope.workspaceId,
            preparationTokenDigest: preparationDigest
          }).pipe(
            Effect.mapError((failure) =>
              Predicate.isTagged("RecordNotFoundError")(failure)
                ? new GovernedActionExecutionStoreError({ operation: "begin", reason: "not-found" })
                : failure
            )
          )
          const consumePreparation = Effect.fn("GovernedActionExecutionBegin.consumePreparation")(function*() {
            if (!(yield* preparations.consume(preparation))) {
              return yield* new GovernedActionExecutionStoreError({ operation: "begin", reason: "conflict" })
            }
          })
          if (
            preparation.workspaceId !== input.scope.workspaceId ||
            current.scope.workspaceId !== input.scope.workspaceId ||
            current.scope.pluginConnectionId !== input.scope.pluginConnectionId
          ) {
            return yield* new GovernedActionExecutionStoreError({ operation: "begin", reason: "conflict" })
          }

          const record = yield* transaction.read({
            workspaceId: preparation.workspaceId,
            actionId: preparation.actionId
          })
          if (record.head.state !== "authorized" || record.authorization === null) {
            yield* consumePreparation()
            return inactive(record.head.state)
          }
          if (
            record.headTransition.transitionId !== preparation.expectedHeadTransitionId ||
            record.envelope.envelopeDigest !== preparation.expectedEnvelopeDigest ||
            record.envelope.pluginConnectionId !== input.scope.pluginConnectionId
          ) {
            return yield* new GovernedActionExecutionStoreError({ operation: "begin", reason: "conflict" })
          }
          if (
            DateTime.Order(now, record.authorization.expiresAt) >= 0 ||
            DateTime.Order(now, record.envelope.proposalExpiresAt) >= 0
          ) {
            const transitionId = GovernedActionTransitionId.make(yield* cryptoService.randomUUIDv7)
            const auditEventId = DomainEventId.make(yield* cryptoService.randomUUIDv7)
            const expired = yield* Schema.decodeUnknownEffect(Schema.toType(GovernedActionCommitInput))({
              envelope: record.envelope,
              expectedHeadTransitionId: record.headTransition.transitionId,
              transitionId,
              commandId: GovernedActionCommandId.make(`execution:expire:${preparationDigest}`),
              command: { _tag: "expire", reason: "authorization-expired" },
              cause: { _tag: "system", component: "governed-action-execution" },
              occurredAt: now,
              causationId: record.envelope.causationId,
              correlationId: record.envelope.correlationId,
              companion: { _tag: "none" },
              auditEventId
            })
            const committed = yield* writer.commit(expired)
            yield* consumePreparation()
            return inactive(committed.transition.toState)
          }
          if (DateTime.Order(now, preparation.expiresAt) >= 0) {
            yield* consumePreparation()
            return inactive(record.head.state)
          }
          if (
            input.preflight.checkedRevision !== record.envelope.proposal.request.expectedRevision ||
            DateTime.Order(input.preflight.checkedAt, preparation.createdAt) < 0 ||
            DateTime.Order(input.preflight.checkedAt, now) > 0 ||
            !hasReconciliation(current)
          ) {
            return yield* new GovernedActionExecutionStoreError({ operation: "begin", reason: "conflict" })
          }

          const currentSession = yield* sessions.read({
            workspaceId: record.envelope.workspaceId,
            sessionId: record.authorization.sessionId
          })
          const publication = record.envelope.releasePublication
          if (publication !== undefined) {
            const rows = yield* sql<SqlRow>`SELECT
                revision.snapshot_json AS snapshotJson
              FROM releases AS release
              JOIN release_revisions AS revision
                ON revision.workspace_id = release.workspace_id
                AND revision.release_id = release.release_id
                AND revision.revision = release.current_revision
              WHERE release.workspace_id = ${record.envelope.workspaceId}
                AND release.release_id = ${publication.releaseId}`
            const row = rows[0]
            if (row === undefined || rows.length !== 1) {
              return yield* new GovernedActionExecutionStoreError({
                operation: "begin",
                reason: "authority-changed"
              })
            }
            const decodedRow = yield* Schema.decodeUnknownEffect(CurrentReleaseSnapshotRow)(row).pipe(
              Effect.mapError(() =>
                new GovernedActionExecutionStoreError({ operation: "begin", reason: "invalid-record" })
              )
            )
            const release = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Release))(decodedRow.snapshotJson)
              .pipe(
                Effect.mapError(() =>
                  new GovernedActionExecutionStoreError({ operation: "begin", reason: "invalid-record" })
                )
              )
            const currentSourceRevisionDigest = yield* digestReleaseSourceRevisions(release.sourceRevisions).pipe(
              Effect.provideService(Crypto.Crypto, cryptoService),
              Effect.mapError(() =>
                new GovernedActionExecutionStoreError({ operation: "begin", reason: "persistence-unavailable" })
              )
            )
            if (currentSourceRevisionDigest !== publication.sourceRevisionDigest) {
              return yield* new GovernedActionExecutionStoreError({
                operation: "begin",
                reason: "authority-changed"
              })
            }
          }
          // Release publication destinations do not exist as normalized
          // entities before creation. Bind authority to the exact release and
          // immutable provider request here; the negotiated executor preflight
          // remains responsible for checking the live destination/version.
          const currentTarget = publication !== undefined &&
              record.envelope.targetEntityId === EntityId.make(publication.releaseId)
            ? yield* Schema.decodeUnknownEffect(Schema.toType(GovernedActionTargetSnapshotV1))({
              workspaceId: record.envelope.workspaceId,
              entityId: record.envelope.targetEntityId,
              entityType: record.envelope.proposal.request.target.entityType,
              sourceRevision: {
                providerId: record.envelope.providerId,
                pluginConnectionId: record.envelope.pluginConnectionId,
                vendorImmutableId: record.envelope.proposal.request.target.vendorImmutableId,
                revision: record.envelope.proposal.request.expectedRevision,
                sourceUrl: null,
                firstObservedAt: now,
                lastObservedAt: now,
                synchronizedAt: now,
                normalizationSchemaVersion: 1
              }
            })
            : yield* targets.read({
              workspaceId: record.envelope.workspaceId,
              entityId: record.envelope.targetEntityId
            })
          const currentEvidence = yield* evidence.read({
            workspaceId: record.envelope.workspaceId,
            evidence: record.envelope.evidence,
            now
          })
          const attemptCountRows = yield* sql<SqlRow>`WITH RECURSIVE
            retry_edges(source_execution_id, result_execution_id) AS (
              SELECT source.vendor_immutable_id, retry.provider_operation_id
              FROM governed_actions AS retry
              JOIN governed_action_target_dimensions AS retry_dimensions
                ON retry_dimensions.workspace_id = retry.workspace_id
                AND retry_dimensions.action_id = retry.action_id
                AND retry_dimensions.action_kind = 'pipeline.retry'
              JOIN entities AS source
                ON source.workspace_id = retry.workspace_id
                AND source.entity_id = retry.target_entity_id
                AND source.plugin_connection_id = retry.plugin_connection_id
                AND source.provider_id = retry.provider_id
              WHERE retry.workspace_id = ${record.envelope.workspaceId}
                AND retry.plugin_connection_id = ${record.envelope.pluginConnectionId}
                AND retry.provider_id = 'codepipeline'
                AND retry.provider_operation_id IS NOT NULL
            ),
            retry_component(execution_id) AS (
              SELECT target.vendor_immutable_id
              FROM entities AS target
              WHERE target.workspace_id = ${record.envelope.workspaceId}
                AND target.entity_id = ${record.envelope.targetEntityId}
                AND target.plugin_connection_id = ${record.envelope.pluginConnectionId}
                AND target.provider_id = 'codepipeline'
              UNION
              SELECT edge.result_execution_id
              FROM retry_edges AS edge
              JOIN retry_component AS component
                ON edge.source_execution_id = component.execution_id
              UNION
              SELECT edge.source_execution_id
              FROM retry_edges AS edge
              JOIN retry_component AS component
                ON edge.result_execution_id = component.execution_id
            )
            SELECT COUNT(DISTINCT attempt.attempt_id) AS count
            FROM governed_action_attempts AS attempt
            JOIN governed_actions AS action
              ON action.workspace_id = attempt.workspace_id
              AND action.action_id = attempt.action_id
            JOIN governed_action_target_dimensions AS dimensions
              ON dimensions.workspace_id = action.workspace_id
              AND dimensions.action_id = action.action_id
            JOIN entities AS target
              ON target.workspace_id = action.workspace_id
              AND target.entity_id = action.target_entity_id
              AND target.plugin_connection_id = action.plugin_connection_id
              AND target.provider_id = action.provider_id
            WHERE action.workspace_id = ${record.envelope.workspaceId}
              AND action.plugin_connection_id = ${record.envelope.pluginConnectionId}
              AND action.provider_id = 'codepipeline'
              AND dimensions.action_kind = 'pipeline.retry'
              AND target.vendor_immutable_id IN (
                SELECT execution_id FROM retry_component
              )`
          const decodedAttemptCountRows = yield* Schema.decodeUnknownEffect(
            Schema.Array(AttemptCountRow)
          )(attemptCountRows)
          const attemptCountRow = decodedAttemptCountRows[0]
          if (decodedAttemptCountRows.length !== 1 || attemptCountRow === undefined) {
            return yield* new GovernedActionExecutionStoreError({
              operation: "begin",
              reason: "persistence-unavailable"
            })
          }
          const currentPolicy = yield* policy.evaluate({
            envelope: record.envelope,
            currentEvidence,
            session: currentSession,
            evaluatedAt: now,
            priorTargetAttempts: attemptCountRow.count
          })
          if (currentPolicy.decision !== "allowed") {
            const transitionId = GovernedActionTransitionId.make(yield* cryptoService.randomUUIDv7)
            const auditEventId = DomainEventId.make(yield* cryptoService.randomUUIDv7)
            const denied = yield* Schema.decodeUnknownEffect(Schema.toType(GovernedActionCommitInput))({
              envelope: record.envelope,
              expectedHeadTransitionId: record.headTransition.transitionId,
              transitionId,
              commandId: GovernedActionCommandId.make(`execution:deny:${preparationDigest}`),
              command: {
                _tag: "deny",
                reason: "policy-denied",
                safeSummary: "Current policy no longer permits this action"
              },
              cause: { _tag: "system", component: "governed-action-execution" },
              occurredAt: now,
              causationId: record.envelope.causationId,
              correlationId: record.envelope.correlationId,
              companion: { _tag: "policyDenial", policyEvaluation: currentPolicy },
              auditEventId
            })
            const committed = yield* writer.commit(denied)
            yield* consumePreparation()
            return inactive(committed.transition.toState)
          }

          const policyEvaluationDigest = yield* digestGovernedActionPolicyEvaluation(currentPolicy).pipe(
            Effect.provideService(Crypto.Crypto, cryptoService)
          )
          const attemptId = GovernedActionAttemptId.make(yield* cryptoService.randomUUIDv7)
          const attempt = yield* Schema.decodeUnknownEffect(Schema.toType(GovernedActionAttemptV1))({
            schemaVersion: 1,
            attemptId,
            authorizationId: record.authorization.authorizationId,
            actionId: record.envelope.actionId,
            workspaceId: record.envelope.workspaceId,
            pluginConnectionId: record.envelope.pluginConnectionId,
            idempotencyKey: record.envelope.idempotencyKey,
            attemptNumber: 1,
            actionEnvelopeDigest: record.envelope.envelopeDigest,
            expectedRevision: record.envelope.proposal.request.expectedRevision,
            policyEvaluationDigest,
            preflight: input.preflight,
            startedAt: now
          })
          yield* verifyGovernedActionDispatchAuthority({
            envelope: record.envelope,
            authorization: record.authorization,
            attempt,
            currentEvidence,
            currentPlugin: {
              authorityDigest: GovernedActionPluginConnectionAuthorityDigest.make(current.runtimeAuthorityToken),
              connectionId: current.scope.pluginConnectionId,
              enabled: true,
              negotiated: current.negotiated,
              providerId: current.expected.providerId,
              revision: GovernedActionPluginConnectionRevision.make(current.expected.connectionRevision),
              workspaceId: current.scope.workspaceId
            },
            currentPolicy,
            currentTarget,
            session: currentSession,
            evaluatedAt: now
          }).pipe(Effect.provideService(Crypto.Crypto, cryptoService))

          const transitionId = GovernedActionTransitionId.make(yield* cryptoService.randomUUIDv7)
          const auditEventId = DomainEventId.make(yield* cryptoService.randomUUIDv7)
          const permit = yield* issueGovernedActionPermitToken().pipe(
            Effect.provideService(Crypto.Crypto, cryptoService)
          )
          const commit = yield* Schema.decodeUnknownEffect(Schema.toType(GovernedActionCommitInput))({
            envelope: record.envelope,
            expectedHeadTransitionId: record.headTransition.transitionId,
            transitionId,
            commandId: GovernedActionCommandId.make(`execution:start:${preparationDigest}`),
            command: { _tag: "start", attemptId },
            cause: { _tag: "system", component: "governed-action-execution" },
            occurredAt: now,
            causationId: record.envelope.causationId,
            correlationId: record.envelope.correlationId,
            companion: { _tag: "dispatch", policyEvaluation: currentPolicy, attempt },
            auditEventId
          })
          const result = yield* writer.commit(commit)
          if (result._tag === "replayed") {
            yield* consumePreparation()
            return inactive(result.transition.toState)
          }

          const dispatchDeadline = earlier(
            DateTime.add(now, { seconds: DISPATCH_WINDOW_SECONDS }),
            record.authorization.expiresAt
          )
          if (DateTime.Order(now, dispatchDeadline) >= 0) {
            return yield* new GovernedActionExecutionStoreError({ operation: "begin", reason: "conflict" })
          }
          const leaseExpiresAt = DateTime.add(dispatchDeadline, { seconds: LEASE_GRACE_SECONDS })
          const recoveryEligibleAt = DateTime.add(leaseExpiresAt, { seconds: RECOVERY_SAFETY_SECONDS })
          yield* sql`INSERT INTO governed_action_execution_leases (
          workspace_id, action_id, attempt_id, start_transition_id,
          permit_token_digest, runtime_authority_token, recovery_capability_version,
          created_at, dispatch_deadline, lease_expires_at, recovery_eligible_at
        ) VALUES (
          ${record.envelope.workspaceId}, ${record.envelope.actionId}, ${attemptId}, ${transitionId},
          ${permit.digest}, ${current.runtimeAuthorityToken}, 1,
          ${DateTime.formatIso(now)}, ${DateTime.formatIso(dispatchDeadline)},
          ${DateTime.formatIso(leaseExpiresAt)}, ${DateTime.formatIso(recoveryEligibleAt)}
        )`
          yield* consumePreparation()
          const request = yield* Schema.decodeUnknownEffect(Schema.toType(AuthorizedPluginActionV1))({
            proposal: record.envelope.proposal,
            idempotencyKey: record.envelope.idempotencyKey,
            payloadDigest: record.envelope.proposal.payloadDigest,
            authorizationId: record.authorization.authorizationId,
            authorizedAt: record.authorization.authorizedAt,
            expiresAt: record.authorization.expiresAt
          })
          return {
            _tag: "permitted",
            permitToken: permit.token,
            runtimeAuthorityToken: current.runtimeAuthorityToken,
            dispatchDeadline,
            leaseExpiresAt,
            recovery: { strategy: "idempotency", capabilityVersion: 1 },
            scope: current.scope,
            request
          } satisfies GovernedActionBeginResult
        })
    ).pipe(
      transaction.capture,
      Effect.mapError(storeFailure)
    )
  })

  return { begin }
})
