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
  type GovernedActionState
} from "../../../../domain/governedAction/index.js"
import { DomainEventId, GovernedActionAttemptId, GovernedActionTransitionId } from "../../../../domain/identifiers.js"
import { AuthorizedPluginActionV1 } from "../../../../domain/plugins/actions.js"
import type { UtcTimestamp } from "../../../../domain/utcTimestamp.js"
import { Database } from "../../../persistence/Database.js"
import { GovernedActionCommitInput } from "../../../persistence/repositories/governed-action/contract.js"
import { makeGovernedActionTransaction } from "../../../persistence/repositories/governed-action/transaction.js"
import { makeGovernedActionTransactionWrite } from "../../../persistence/repositories/governed-action/write.js"
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

const inactive = (state: GovernedActionState): GovernedActionBeginResult => ({
  _tag: "inactive",
  state
})

const storeFailure = (failure: unknown): GovernedActionExecutionStoreError => {
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
          const currentTarget = yield* targets.read({
            workspaceId: record.envelope.workspaceId,
            entityId: record.envelope.targetEntityId
          })
          const currentEvidence = yield* evidence.read({
            workspaceId: record.envelope.workspaceId,
            evidence: record.envelope.evidence,
            now
          })
          const currentPolicy = yield* policy.evaluate({
            envelope: record.envelope,
            currentEvidence,
            session: currentSession,
            evaluatedAt: now
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
