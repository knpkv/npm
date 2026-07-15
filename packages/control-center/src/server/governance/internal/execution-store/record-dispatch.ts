import * as Clock from "effect/Clock"
import * as Crypto from "effect/Crypto"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"

import { GovernedActionCommandDigest, GovernedActionCommandId } from "../../../../domain/governedAction/index.js"
import {
  DomainEventId,
  GovernedActionId,
  GovernedActionTransitionId,
  WorkspaceId
} from "../../../../domain/identifiers.js"
import { PluginActionDispatchResultV1 } from "../../../../domain/plugins/actions.js"
import { UtcTimestamp } from "../../../../domain/utcTimestamp.js"
import { Database } from "../../../persistence/Database.js"
import { GovernedActionCommitInput } from "../../../persistence/repositories/governed-action/contract.js"
import { makeGovernedActionTransaction } from "../../../persistence/repositories/governed-action/transaction.js"
import { makeGovernedActionTransactionWrite } from "../../../persistence/repositories/governed-action/write.js"
import {
  digestGovernedActionTransitionCommand,
  encodeGovernedActionDispatchOutcome
} from "../../governedActionDigests.js"
import type { GovernedActionExecutionStoreV1 } from "../GovernedActionExecutionStore.js"
import { GovernedActionExecutionStoreError } from "../GovernedActionExecutionStore.js"
import {
  dispatchResultCommand,
  DispatchResultKind,
  dispatchResultKind,
  dispatchResultObservedAt
} from "./dispatch-outcome.js"
import { digestGovernedActionPermitToken, GovernedActionPermitTokenDigest } from "./tokens.js"

const ExecutionLeaseRow = Schema.Struct({
  workspaceId: WorkspaceId,
  actionId: GovernedActionId,
  permitTokenDigest: GovernedActionPermitTokenDigest,
  createdAt: UtcTimestamp,
  dispatchDeadline: UtcTimestamp,
  leaseExpiresAt: UtcTimestamp,
  recoveryClaimCount: Schema.Int
})

const ExistingOutcomeRow = Schema.Struct({
  workspaceId: WorkspaceId,
  actionId: GovernedActionId,
  outcomeId: Schema.String,
  resultKind: DispatchResultKind,
  outcomeJson: Schema.String,
  outcomeDigest: Schema.String.check(
    Schema.isPattern(/^[0-9a-f]{64}$/u, { expected: "a lowercase SHA-256 digest" })
  ),
  expectedCommandDigest: GovernedActionCommandDigest,
  foldTransitionId: Schema.NullOr(GovernedActionTransitionId)
})

const storeFailure = (failure: unknown): GovernedActionExecutionStoreError => {
  if (Schema.is(GovernedActionExecutionStoreError)(failure)) return failure
  if (Predicate.isTagged("RecordNotFoundError")(failure)) {
    return new GovernedActionExecutionStoreError({ operation: "record-dispatch", reason: "not-found" })
  }
  if (Predicate.isTagged("PersistedRecordError")(failure)) {
    return new GovernedActionExecutionStoreError({ operation: "record-dispatch", reason: "invalid-record" })
  }
  if (Predicate.isTagged("GovernedActionInputError")(failure) || Predicate.isTagged("SchemaError")(failure)) {
    return new GovernedActionExecutionStoreError({ operation: "record-dispatch", reason: "conflict" })
  }
  return new GovernedActionExecutionStoreError({
    operation: "record-dispatch",
    reason: "persistence-unavailable"
  })
}

const conflict = (): GovernedActionExecutionStoreError =>
  new GovernedActionExecutionStoreError({ operation: "record-dispatch", reason: "conflict" })

const invalidRecord = (): GovernedActionExecutionStoreError =>
  new GovernedActionExecutionStoreError({ operation: "record-dispatch", reason: "invalid-record" })

const outcomeMatches = (
  existing: typeof ExistingOutcomeRow.Type,
  expected: {
    readonly actionId: GovernedActionId
    readonly commandDigest: typeof GovernedActionCommandDigest.Type
    readonly outcomeDigest: string
    readonly outcomeJson: string
    readonly resultKind: typeof DispatchResultKind.Type
    readonly workspaceId: WorkspaceId
  }
): boolean =>
  existing.workspaceId === expected.workspaceId &&
  existing.actionId === expected.actionId &&
  existing.resultKind === expected.resultKind &&
  existing.outcomeJson === expected.outcomeJson &&
  existing.outcomeDigest === expected.outcomeDigest &&
  existing.expectedCommandDigest === expected.commandDigest

/** Append one provider dispatch result to its immutable inbox and fold it into the current head. */
export const makeGovernedActionExecutionRecordDispatch = Effect.gen(function*() {
  const { sql } = yield* Database
  const clock = yield* Clock.Clock
  const cryptoService = yield* Crypto.Crypto
  const transaction = yield* makeGovernedActionTransaction
  const writer = yield* makeGovernedActionTransactionWrite

  const readLease = Effect.fn("GovernedActionExecutionRecordDispatch.readLease")(function*(
    permitTokenDigest: GovernedActionPermitTokenDigest
  ) {
    const rows = yield* sql`SELECT
      execution.workspace_id AS workspaceId,
      execution.action_id AS actionId,
      execution.permit_token_digest AS permitTokenDigest,
      execution.created_at AS createdAt,
      execution.dispatch_deadline AS dispatchDeadline,
      execution.lease_expires_at AS leaseExpiresAt,
      (SELECT COUNT(*) FROM governed_action_recovery_claims recovery
        WHERE recovery.workspace_id = execution.workspace_id
          AND recovery.action_id = execution.action_id) AS recoveryClaimCount
    FROM governed_action_execution_leases execution
    WHERE execution.permit_token_digest = ${permitTokenDigest}
    LIMIT 2`
    const decoded = yield* Schema.decodeUnknownEffect(Schema.Array(ExecutionLeaseRow))(rows).pipe(
      Effect.mapError(invalidRecord)
    )
    if (decoded.length === 0) {
      return yield* new GovernedActionExecutionStoreError({
        operation: "record-dispatch",
        reason: "not-found"
      })
    }
    const row = decoded[0]
    if (decoded.length !== 1 || row === undefined) return yield* invalidRecord()
    return row
  })

  const readExisting = Effect.fn("GovernedActionExecutionRecordDispatch.readExisting")(function*(
    permitTokenDigest: GovernedActionPermitTokenDigest
  ) {
    const rows = yield* sql`SELECT
      outcome.workspace_id AS workspaceId,
      outcome.action_id AS actionId,
      outcome.outcome_id AS outcomeId,
      outcome.result_kind AS resultKind,
      outcome.outcome_json AS outcomeJson,
      outcome.outcome_digest AS outcomeDigest,
      outcome.expected_command_digest AS expectedCommandDigest,
      fold.transition_id AS foldTransitionId
    FROM governed_action_provider_outcomes outcome
    LEFT JOIN governed_action_provider_outcome_folds fold
      ON fold.workspace_id = outcome.workspace_id
      AND fold.action_id = outcome.action_id
      AND fold.outcome_id = outcome.outcome_id
    WHERE outcome.permit_token_digest = ${permitTokenDigest}
    LIMIT 2`
    const decoded = yield* Schema.decodeUnknownEffect(Schema.Array(ExistingOutcomeRow))(rows).pipe(
      Effect.mapError(invalidRecord)
    )
    if (decoded.length > 1) return yield* invalidRecord()
    return decoded[0]
  })

  const recordDispatch: GovernedActionExecutionStoreV1["recordDispatch"] = Effect.fn(
    "GovernedActionExecutionRecordDispatch.recordDispatch"
  )(function*(input) {
    const permitTokenDigest = yield* digestGovernedActionPermitToken(input.permitToken).pipe(
      Effect.provideService(Crypto.Crypto, cryptoService),
      Effect.mapError(storeFailure)
    )
    const result = yield* Schema.decodeUnknownEffect(Schema.toType(PluginActionDispatchResultV1))(
      input.result
    ).pipe(Effect.mapError(storeFailure))
    const command = dispatchResultCommand(result)
    const encoded = yield* encodeGovernedActionDispatchOutcome(result).pipe(
      Effect.provideService(Crypto.Crypto, cryptoService),
      Effect.mapError(storeFailure)
    )
    const commandDigest = yield* digestGovernedActionTransitionCommand(command).pipe(
      Effect.provideService(Crypto.Crypto, cryptoService),
      Effect.mapError(storeFailure)
    )

    const persisted = yield* transaction.transact(
      "governed-action.execution-persist-dispatch",
      Effect.gen(function*() {
        const now = DateTime.makeUnsafe(yield* clock.currentTimeMillis)
        const lease = yield* readLease(permitTokenDigest)
        const existing = yield* readExisting(permitTokenDigest)
        if (existing !== undefined) {
          if (
            !outcomeMatches(existing, {
              workspaceId: lease.workspaceId,
              actionId: lease.actionId,
              resultKind: dispatchResultKind(result),
              outcomeJson: encoded.outcomeJson,
              outcomeDigest: encoded.outcomeDigest,
              commandDigest
            })
          ) return yield* conflict()
          return { lease, outcomeId: existing.outcomeId }
        }

        const providerObservedAt = dispatchResultObservedAt(result)
        if (
          DateTime.Order(input.observedAt, now) > 0 ||
          DateTime.Order(providerObservedAt, input.observedAt) > 0 ||
          DateTime.Order(providerObservedAt, lease.createdAt) < 0 ||
          DateTime.Order(providerObservedAt, lease.dispatchDeadline) >= 0 ||
          DateTime.Order(input.observedAt, lease.leaseExpiresAt) >= 0 ||
          lease.recoveryClaimCount !== 0
        ) {
          return yield* conflict()
        }

        const record = yield* transaction.read({
          workspaceId: lease.workspaceId,
          actionId: lease.actionId
        })
        if (record.head.state !== "started" && record.head.state !== "cancel-requested") {
          return yield* conflict()
        }

        const outcomeId = yield* cryptoService.randomUUIDv7
        yield* sql`INSERT INTO governed_action_provider_outcomes (
          workspace_id, action_id, outcome_id, source_kind, permit_token_digest,
          recovery_claim_token_digest, result_kind, schema_version, outcome_json,
          outcome_digest, expected_command_digest, observed_at, received_at
        ) VALUES (
          ${lease.workspaceId}, ${lease.actionId}, ${outcomeId}, 'dispatch', ${permitTokenDigest},
          NULL, ${dispatchResultKind(result)}, 1, ${encoded.outcomeJson}, ${encoded.outcomeDigest},
          ${commandDigest}, ${DateTime.formatIso(providerObservedAt)}, ${DateTime.formatIso(input.observedAt)}
        )`
        return { lease, outcomeId }
      })
    ).pipe(Effect.mapError(storeFailure))

    return yield* transaction.transact(
      "governed-action.execution-fold-dispatch",
      Effect.gen(function*() {
        const existing = yield* readExisting(permitTokenDigest)
        if (
          existing === undefined ||
          existing.outcomeId !== persisted.outcomeId ||
          !outcomeMatches(existing, {
            workspaceId: persisted.lease.workspaceId,
            actionId: persisted.lease.actionId,
            resultKind: dispatchResultKind(result),
            outcomeJson: encoded.outcomeJson,
            outcomeDigest: encoded.outcomeDigest,
            commandDigest
          })
        ) return yield* invalidRecord()

        const record = yield* transaction.read({
          workspaceId: persisted.lease.workspaceId,
          actionId: persisted.lease.actionId
        })
        if (existing.foldTransitionId !== null) return record.head.state
        if (record.head.state !== "started" && record.head.state !== "cancel-requested") {
          return yield* conflict()
        }

        const foldedAt = DateTime.makeUnsafe(yield* clock.currentTimeMillis)
        const transitionId = GovernedActionTransitionId.make(yield* cryptoService.randomUUIDv7)
        const auditEventId = DomainEventId.make(yield* cryptoService.randomUUIDv7)
        const commit = yield* Schema.decodeUnknownEffect(Schema.toType(GovernedActionCommitInput))({
          envelope: record.envelope,
          expectedHeadTransitionId: record.headTransition.transitionId,
          transitionId,
          commandId: GovernedActionCommandId.make(`execution:dispatch:${permitTokenDigest}`),
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
          ${persisted.lease.workspaceId}, ${persisted.lease.actionId}, ${persisted.outcomeId},
          ${committed.transition.transitionId}, ${DateTime.formatIso(foldedAt)}
        )`
        return committed.transition.toState
      })
    ).pipe(Effect.mapError(storeFailure))
  })

  return { recordDispatch }
})
