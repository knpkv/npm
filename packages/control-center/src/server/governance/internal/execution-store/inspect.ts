import * as Clock from "effect/Clock"
import * as Crypto from "effect/Crypto"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"

import { AuthorizedPluginActionV1 } from "../../../../domain/plugins/actions.js"
import type { UtcTimestamp } from "../../../../domain/utcTimestamp.js"
import { Database } from "../../../persistence/Database.js"
import type { GovernedActionRecord } from "../../../persistence/repositories/governed-action/contract.js"
import { makeGovernedActionTransaction } from "../../../persistence/repositories/governed-action/transaction.js"
import type {
  GovernedActionDispatchPreparation,
  GovernedActionExecutionPlan,
  GovernedActionExecutionReference
} from "../GovernedActionExecutionStore.js"
import { GovernedActionExecutionStoreError } from "../GovernedActionExecutionStore.js"
import { makeGovernedActionExecutionPendingDispatchFolder } from "./pending-dispatch.js"
import { issueGovernedActionPreparationToken } from "./tokens.js"

const PREPARATION_LIFETIME_SECONDS = 30
const PREPARATION_CLEANUP_BATCH_SIZE = 256

const inactive = (record: GovernedActionRecord): GovernedActionExecutionPlan => ({
  _tag: "inactive",
  state: record.head.state
})

const earliest = (left: UtcTimestamp, right: UtcTimestamp): UtcTimestamp =>
  DateTime.Order(left, right) <= 0 ? left : right

const storeFailure = (failure: unknown): GovernedActionExecutionStoreError => {
  if (Schema.is(GovernedActionExecutionStoreError)(failure)) return failure
  if (Predicate.isTagged("RecordNotFoundError")(failure)) {
    return new GovernedActionExecutionStoreError({ operation: "inspect", reason: "not-found" })
  }
  if (Predicate.isTagged("PersistedRecordError")(failure)) {
    return new GovernedActionExecutionStoreError({ operation: "inspect", reason: "invalid-record" })
  }
  return new GovernedActionExecutionStoreError({
    operation: "inspect",
    reason: "persistence-unavailable"
  })
}

/**
 * Build authorized action preparation over one verified aggregate transaction.
 * The returned capability is short-lived and cannot authorize provider dispatch by itself.
 */
export const makeGovernedActionExecutionInspect = Effect.gen(function*() {
  const { sql } = yield* Database
  const clock = yield* Clock.Clock
  const cryptoService = yield* Crypto.Crypto
  const transaction = yield* makeGovernedActionTransaction
  const pendingDispatch = yield* makeGovernedActionExecutionPendingDispatchFolder

  const inspect = Effect.fn("GovernedActionExecutionInspect.inspect")(function*(
    reference: GovernedActionExecutionReference
  ) {
    const foldedPending = yield* pendingDispatch.foldPending(reference)
    if (foldedPending !== null) {
      return { _tag: "inactive", state: foldedPending } satisfies GovernedActionExecutionPlan
    }
    return yield* transaction.transact(
      "governed-action.execution-inspect",
      Effect.gen(function*() {
        const record = yield* transaction.read(reference)
        if (record.head.state !== "authorized" || record.authorization === null) {
          return inactive(record)
        }

        const observedAt = DateTime.makeUnsafe(yield* clock.currentTimeMillis)
        // The verified aggregate proves authorization expiry cannot outlive proposal authority.
        const authorityExpiresAt = record.authorization.expiresAt
        if (DateTime.Order(observedAt, authorityExpiresAt) >= 0) return inactive(record)

        yield* sql`DELETE FROM governed_action_execution_preparations
          WHERE preparation_token_digest IN (
            SELECT preparation_token_digest
            FROM governed_action_execution_preparations
            WHERE expires_at <= ${DateTime.formatIso(observedAt)}
            ORDER BY expires_at, preparation_token_digest
            LIMIT ${PREPARATION_CLEANUP_BATCH_SIZE}
          )`

        const expiresAt = earliest(
          DateTime.add(observedAt, { seconds: PREPARATION_LIFETIME_SECONDS }),
          authorityExpiresAt
        )
        const request = yield* Schema.decodeUnknownEffect(Schema.toType(AuthorizedPluginActionV1))({
          proposal: record.envelope.proposal,
          idempotencyKey: record.envelope.idempotencyKey,
          payloadDigest: record.envelope.proposal.payloadDigest,
          authorizationId: record.authorization.authorizationId,
          authorizedAt: record.authorization.authorizedAt,
          expiresAt: record.authorization.expiresAt
        })
        const issued = yield* issueGovernedActionPreparationToken().pipe(
          Effect.provideService(Crypto.Crypto, cryptoService)
        )

        yield* sql`INSERT INTO governed_action_execution_preparations (
        preparation_token_digest, workspace_id, action_id,
        expected_head_transition_id, expected_envelope_digest, created_at, expires_at
      ) VALUES (
        ${issued.digest}, ${record.envelope.workspaceId}, ${record.envelope.actionId},
        ${record.headTransition.transitionId}, ${record.envelope.envelopeDigest},
        ${DateTime.formatIso(observedAt)}, ${DateTime.formatIso(expiresAt)}
      )`

        return {
          _tag: "dispatch",
          preparationToken: issued.token,
          scope: {
            workspaceId: record.envelope.workspaceId,
            pluginConnectionId: record.envelope.pluginConnectionId
          },
          request
        } satisfies GovernedActionDispatchPreparation
      })
    ).pipe(Effect.mapError(storeFailure))
  })

  return { inspect }
})
