import * as Clock from "effect/Clock"
import * as Crypto from "effect/Crypto"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"

import { GovernedActionCommandId } from "../../../../domain/governedAction/index.js"
import { DomainEventId, GovernedActionTransitionId } from "../../../../domain/identifiers.js"
import { GovernedActionCommitInput } from "../../../persistence/repositories/governed-action/contract.js"
import { makeGovernedActionTransaction } from "../../../persistence/repositories/governed-action/transaction.js"
import { makeGovernedActionTransactionWrite } from "../../../persistence/repositories/governed-action/write.js"
import type { GovernedActionExecutionStoreV1 } from "../GovernedActionExecutionStore.js"
import { GovernedActionExecutionStoreError } from "../GovernedActionExecutionStore.js"
import { makeGovernedActionExecutionPreparationReader } from "./preparation.js"
import { digestGovernedActionPreparationToken } from "./tokens.js"

const storeFailure = (failure: unknown): GovernedActionExecutionStoreError => {
  if (Schema.is(GovernedActionExecutionStoreError)(failure)) return failure
  if (Predicate.isTagged("RecordNotFoundError")(failure)) {
    return new GovernedActionExecutionStoreError({ operation: "block", reason: "not-found" })
  }
  if (Predicate.isTagged("PersistedRecordError")(failure)) {
    return new GovernedActionExecutionStoreError({ operation: "block", reason: "invalid-record" })
  }
  if (Predicate.isTagged("GovernedActionInputError")(failure)) {
    return new GovernedActionExecutionStoreError({ operation: "block", reason: "conflict" })
  }
  return new GovernedActionExecutionStoreError({ operation: "block", reason: "persistence-unavailable" })
}

/** Project many provider reasons into the lifecycle's deliberately bounded display summary. */
const blockedSummary = (reasons: ReadonlyArray<string>): string => {
  const first = reasons[0] ?? "Provider preflight blocked this action"
  const suffix = reasons.length > 1 ? ` (+${reasons.length - 1} more)` : ""
  return `${first.slice(0, 1_000 - suffix.length)}${suffix}`
}

/** Consume one exact preparation and record that provider preflight denied dispatch. */
export const makeGovernedActionExecutionRecordBlocked = Effect.gen(function*() {
  const clock = yield* Clock.Clock
  const cryptoService = yield* Crypto.Crypto
  const transaction = yield* makeGovernedActionTransaction
  const writer = yield* makeGovernedActionTransactionWrite
  const preparations = yield* makeGovernedActionExecutionPreparationReader

  const recordBlocked: GovernedActionExecutionStoreV1["recordBlocked"] = Effect.fn(
    "GovernedActionExecutionRecordBlocked.recordBlocked"
  )(function*(input) {
    const preparationDigest = yield* digestGovernedActionPreparationToken(input.preparationToken).pipe(
      Effect.provideService(Crypto.Crypto, cryptoService),
      Effect.mapError(storeFailure)
    )
    return yield* transaction.transact(
      "governed-action.execution-record-blocked",
      Effect.gen(function*() {
        const now = DateTime.makeUnsafe(yield* clock.currentTimeMillis)
        const preparation = yield* preparations.read({
          workspaceId: input.scope.workspaceId,
          preparationTokenDigest: preparationDigest
        })
        const consumePreparation = Effect.fn(
          "GovernedActionExecutionRecordBlocked.consumePreparation"
        )(function*() {
          if (!(yield* preparations.consume(preparation))) {
            return yield* new GovernedActionExecutionStoreError({ operation: "block", reason: "conflict" })
          }
        })
        const record = yield* transaction.read({
          workspaceId: preparation.workspaceId,
          actionId: preparation.actionId
        })
        if (
          record.envelope.envelopeDigest !== preparation.expectedEnvelopeDigest ||
          record.envelope.pluginConnectionId !== input.scope.pluginConnectionId ||
          DateTime.Order(input.observedAt, now) > 0 ||
          DateTime.Order(input.preflight.checkedAt, preparation.createdAt) < 0 ||
          DateTime.Order(input.preflight.checkedAt, input.observedAt) > 0
        ) {
          return yield* new GovernedActionExecutionStoreError({ operation: "block", reason: "conflict" })
        }
        if (record.head.state !== "authorized" || record.authorization === null) {
          yield* consumePreparation()
          return record.head.state
        }
        if (record.headTransition.transitionId !== preparation.expectedHeadTransitionId) {
          return yield* new GovernedActionExecutionStoreError({ operation: "block", reason: "conflict" })
        }

        if (
          DateTime.Order(input.observedAt, record.authorization.expiresAt) >= 0 ||
          DateTime.Order(input.observedAt, record.envelope.proposalExpiresAt) >= 0
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
            occurredAt: input.observedAt,
            causationId: record.envelope.causationId,
            correlationId: record.envelope.correlationId,
            companion: { _tag: "none" },
            auditEventId
          })
          const committed = yield* writer.commit(expired)
          yield* consumePreparation()
          return committed.transition.toState
        }
        if (DateTime.Order(input.observedAt, preparation.expiresAt) >= 0) {
          yield* consumePreparation()
          return record.head.state
        }

        const transitionId = GovernedActionTransitionId.make(yield* cryptoService.randomUUIDv7)
        const auditEventId = DomainEventId.make(yield* cryptoService.randomUUIDv7)
        const denied = yield* Schema.decodeUnknownEffect(Schema.toType(GovernedActionCommitInput))({
          envelope: record.envelope,
          expectedHeadTransitionId: record.headTransition.transitionId,
          transitionId,
          commandId: GovernedActionCommandId.make(`execution:block:${preparationDigest}`),
          command: {
            _tag: "deny",
            reason: "preflight-blocked",
            safeSummary: blockedSummary(input.preflight.reasons)
          },
          cause: { _tag: "system", component: "governed-action-execution" },
          occurredAt: input.observedAt,
          causationId: record.envelope.causationId,
          correlationId: record.envelope.correlationId,
          companion: { _tag: "none" },
          auditEventId
        })
        const committed = yield* writer.commit(denied)
        yield* consumePreparation()
        return committed.transition.toState
      })
    ).pipe(Effect.mapError(storeFailure))
  })

  return { recordBlocked }
})
