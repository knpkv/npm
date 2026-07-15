import * as Clock from "effect/Clock"
import * as Crypto from "effect/Crypto"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"

import { GovernedActionCommandDigest, GovernedActionCommandId } from "../../../../domain/governedAction/index.js"
import { DomainEventId, GovernedActionTransitionId } from "../../../../domain/identifiers.js"
import { UtcTimestamp } from "../../../../domain/utcTimestamp.js"
import { Database } from "../../../persistence/Database.js"
import { GovernedActionCommitInput } from "../../../persistence/repositories/governed-action/contract.js"
import { makeGovernedActionTransaction } from "../../../persistence/repositories/governed-action/transaction.js"
import { makeGovernedActionTransactionWrite } from "../../../persistence/repositories/governed-action/write.js"
import { digestGovernedActionTransitionCommand } from "../../governedActionDigests.js"
import type { GovernedActionExecutionReference } from "../GovernedActionExecutionStore.js"
import { GovernedActionExecutionStoreError } from "../GovernedActionExecutionStore.js"
import {
  DispatchInboxOutcome,
  dispatchResultCommand,
  DispatchResultKind,
  dispatchResultKind,
  dispatchResultObservedAt,
  encodeDispatchInboxOutcome
} from "./dispatch-outcome.js"
import { GovernedActionPermitTokenDigest } from "./tokens.js"

const PendingDispatchRow = Schema.Struct({
  outcomeId: Schema.String,
  permitTokenDigest: GovernedActionPermitTokenDigest,
  resultKind: DispatchResultKind,
  outcomeJson: Schema.String,
  outcomeDigest: Schema.String.check(
    Schema.isPattern(/^[0-9a-f]{64}$/u, { expected: "a lowercase SHA-256 digest" })
  ),
  expectedCommandDigest: GovernedActionCommandDigest,
  observedAt: UtcTimestamp,
  receivedAt: UtcTimestamp
})

const invalidRecord = (): GovernedActionExecutionStoreError =>
  new GovernedActionExecutionStoreError({ operation: "inspect", reason: "invalid-record" })

const storeFailure = (failure: unknown): GovernedActionExecutionStoreError => {
  if (Schema.is(GovernedActionExecutionStoreError)(failure)) return failure
  if (Predicate.isTagged("RecordNotFoundError")(failure)) {
    return new GovernedActionExecutionStoreError({ operation: "inspect", reason: "not-found" })
  }
  if (Predicate.isTagged("PersistedRecordError")(failure)) return invalidRecord()
  if (Predicate.isTagged("GovernedActionInputError")(failure)) {
    return new GovernedActionExecutionStoreError({ operation: "inspect", reason: "conflict" })
  }
  return new GovernedActionExecutionStoreError({ operation: "inspect", reason: "persistence-unavailable" })
}

/** Fold a crash-stranded dispatch receipt using only its persisted workspace/action identity. */
export const makeGovernedActionExecutionPendingDispatchFolder = Effect.gen(function*() {
  const { sql } = yield* Database
  const clock = yield* Clock.Clock
  const cryptoService = yield* Crypto.Crypto
  const transaction = yield* makeGovernedActionTransaction
  const writer = yield* makeGovernedActionTransactionWrite

  const foldPending = Effect.fn("GovernedActionExecutionPendingDispatchFolder.foldPending")(function*(
    reference: GovernedActionExecutionReference
  ) {
    return yield* transaction.transact(
      "governed-action.execution-fold-pending-dispatch",
      Effect.gen(function*() {
        const rows = yield* sql`SELECT
          outcome.outcome_id AS outcomeId,
          outcome.permit_token_digest AS permitTokenDigest,
          outcome.result_kind AS resultKind,
          outcome.outcome_json AS outcomeJson,
          outcome.outcome_digest AS outcomeDigest,
          outcome.expected_command_digest AS expectedCommandDigest,
          outcome.observed_at AS observedAt,
          outcome.received_at AS receivedAt
        FROM governed_action_provider_outcomes outcome
        LEFT JOIN governed_action_provider_outcome_folds fold
          ON fold.workspace_id = outcome.workspace_id
          AND fold.action_id = outcome.action_id
          AND fold.outcome_id = outcome.outcome_id
        WHERE outcome.workspace_id = ${reference.workspaceId}
          AND outcome.action_id = ${reference.actionId}
          AND outcome.source_kind = 'dispatch'
          AND fold.outcome_id IS NULL
        ORDER BY outcome.received_at, outcome.outcome_id
        LIMIT 2`
        const pending = yield* Schema.decodeUnknownEffect(Schema.Array(PendingDispatchRow))(rows).pipe(
          Effect.mapError(invalidRecord)
        )
        if (pending.length === 0) return null
        const row = pending[0]
        if (pending.length !== 1 || row === undefined) return yield* invalidRecord()

        const result = yield* Schema.decodeUnknownEffect(
          Schema.fromJsonString(DispatchInboxOutcome)
        )(row.outcomeJson).pipe(Effect.mapError(invalidRecord))
        const command = dispatchResultCommand(result)
        const encoded = yield* encodeDispatchInboxOutcome(result).pipe(
          Effect.provideService(Crypto.Crypto, cryptoService),
          Effect.mapError(storeFailure)
        )
        const commandDigest = yield* digestGovernedActionTransitionCommand(command).pipe(
          Effect.provideService(Crypto.Crypto, cryptoService),
          Effect.mapError(storeFailure)
        )
        if (
          row.resultKind !== dispatchResultKind(result) ||
          row.outcomeJson !== encoded.outcomeJson ||
          row.outcomeDigest !== encoded.outcomeDigest ||
          row.expectedCommandDigest !== commandDigest ||
          DateTime.Order(row.observedAt, dispatchResultObservedAt(result)) !== 0
        ) return yield* invalidRecord()

        const record = yield* transaction.read(reference)
        if (record.head.state !== "started" && record.head.state !== "cancel-requested") {
          return yield* new GovernedActionExecutionStoreError({ operation: "inspect", reason: "conflict" })
        }
        const foldedAt = DateTime.makeUnsafe(yield* clock.currentTimeMillis)
        if (DateTime.Order(foldedAt, row.receivedAt) < 0) {
          return yield* new GovernedActionExecutionStoreError({ operation: "inspect", reason: "conflict" })
        }
        const transitionId = GovernedActionTransitionId.make(yield* cryptoService.randomUUIDv7)
        const auditEventId = DomainEventId.make(yield* cryptoService.randomUUIDv7)
        const commit = yield* Schema.decodeUnknownEffect(Schema.toType(GovernedActionCommitInput))({
          envelope: record.envelope,
          expectedHeadTransitionId: record.headTransition.transitionId,
          transitionId,
          commandId: GovernedActionCommandId.make(`execution:dispatch:${row.permitTokenDigest}`),
          command,
          cause: { _tag: "system", component: "governed-action-execution" },
          occurredAt: foldedAt,
          causationId: record.envelope.causationId,
          correlationId: record.envelope.correlationId,
          companion: { _tag: "none" },
          auditEventId
        })
        const committed = yield* writer.commit(commit)
        yield* sql`INSERT INTO governed_action_provider_outcome_folds (
          workspace_id, action_id, outcome_id, transition_id, folded_at
        ) VALUES (
          ${reference.workspaceId}, ${reference.actionId}, ${row.outcomeId},
          ${committed.transition.transitionId}, ${DateTime.formatIso(foldedAt)}
        )`
        return committed.transition.toState
      })
    ).pipe(Effect.mapError(storeFailure))
  })

  return { foldPending }
})
