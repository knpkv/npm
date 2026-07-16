import * as Clock from "effect/Clock"
import * as Crypto from "effect/Crypto"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"

import { GovernedActionCommandDigest } from "../../../../domain/governedAction/index.js"
import { GovernedActionId, GovernedActionTransitionId, WorkspaceId } from "../../../../domain/identifiers.js"
import { UtcTimestamp } from "../../../../domain/utcTimestamp.js"
import { Database } from "../../../persistence/Database.js"
import { makeGovernedActionTransaction } from "../../../persistence/repositories/governed-action/transaction.js"
import { digestGovernedActionTransitionCommand } from "../../governedActionDigests.js"
import { GovernedActionExecutionStoreError } from "../GovernedActionExecutionStore.js"
import {
  type DispatchInboxOutcome,
  dispatchInboxOutcomeCommand,
  dispatchInboxOutcomeKind,
  dispatchInboxOutcomeObservedAt,
  DispatchResultKind,
  encodeDispatchInboxOutcome
} from "./dispatch-outcome.js"
import { makeGovernedActionExecutionProviderOutcomeFolder } from "./provider-outcome-fold.js"
import {
  digestGovernedActionPermitToken,
  type GovernedActionPermitToken,
  GovernedActionPermitTokenDigest
} from "./tokens.js"

type DispatchInboxOperation = "record-dispatch" | "record-unknown"

interface DispatchInboxInput {
  readonly operation: DispatchInboxOperation
  readonly outcome: DispatchInboxOutcome
  readonly permitToken: GovernedActionPermitToken
  readonly receivedAt: UtcTimestamp
}

const ExecutionLeaseRow = Schema.Struct({
  workspaceId: WorkspaceId,
  actionId: GovernedActionId,
  permitTokenDigest: GovernedActionPermitTokenDigest,
  createdAt: Schema.String.pipe(Schema.decodeTo(UtcTimestamp)),
  dispatchDeadline: Schema.String.pipe(Schema.decodeTo(UtcTimestamp)),
  leaseExpiresAt: Schema.String.pipe(Schema.decodeTo(UtcTimestamp)),
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

const storeError = (
  operation: DispatchInboxOperation,
  reason: GovernedActionExecutionStoreError["reason"]
): GovernedActionExecutionStoreError => new GovernedActionExecutionStoreError({ operation, reason })

const mapStoreFailure = (
  operation: DispatchInboxOperation,
  failure: unknown
): GovernedActionExecutionStoreError => {
  if (Schema.is(GovernedActionExecutionStoreError)(failure)) return failure
  if (Predicate.isTagged("RecordNotFoundError")(failure)) return storeError(operation, "not-found")
  if (Predicate.isTagged("PersistedRecordError")(failure)) return storeError(operation, "invalid-record")
  if (Predicate.isTagged("GovernedActionInputError")(failure) || Predicate.isTagged("SchemaError")(failure)) {
    return storeError(operation, "conflict")
  }
  return storeError(operation, "persistence-unavailable")
}

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

/** Build the single durable append-then-fold boundary shared by dispatch-side outcomes. */
export const makeGovernedActionExecutionDispatchInbox = Effect.gen(function*() {
  const { sql } = yield* Database
  const clock = yield* Clock.Clock
  const cryptoService = yield* Crypto.Crypto
  const transaction = yield* makeGovernedActionTransaction
  const folder = yield* makeGovernedActionExecutionProviderOutcomeFolder

  const readLease = Effect.fn("GovernedActionExecutionDispatchInbox.readLease")(function*(
    permitTokenDigest: GovernedActionPermitTokenDigest,
    operation: DispatchInboxOperation
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
      Effect.mapError(() => storeError(operation, "invalid-record"))
    )
    if (decoded.length === 0) return yield* storeError(operation, "not-found")
    const row = decoded[0]
    if (decoded.length !== 1 || row === undefined) return yield* storeError(operation, "invalid-record")
    return row
  })

  const readExisting = Effect.fn("GovernedActionExecutionDispatchInbox.readExisting")(function*(
    permitTokenDigest: GovernedActionPermitTokenDigest,
    operation: DispatchInboxOperation
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
      Effect.mapError(() => storeError(operation, "invalid-record"))
    )
    if (decoded.length > 1) return yield* storeError(operation, "invalid-record")
    return decoded[0]
  })

  const recordOutcome = Effect.fn("GovernedActionExecutionDispatchInbox.recordOutcome")(function*(
    input: DispatchInboxInput
  ) {
    const mapFailure = (failure: unknown): GovernedActionExecutionStoreError =>
      mapStoreFailure(input.operation, failure)
    const permitTokenDigest = yield* digestGovernedActionPermitToken(input.permitToken).pipe(
      Effect.provideService(Crypto.Crypto, cryptoService),
      Effect.mapError(mapFailure)
    )
    const command = dispatchInboxOutcomeCommand(input.outcome)
    const encoded = yield* encodeDispatchInboxOutcome(input.outcome).pipe(
      Effect.provideService(Crypto.Crypto, cryptoService),
      Effect.mapError(mapFailure)
    )
    const commandDigest = yield* digestGovernedActionTransitionCommand(command).pipe(
      Effect.provideService(Crypto.Crypto, cryptoService),
      Effect.mapError(mapFailure)
    )
    const resultKind = dispatchInboxOutcomeKind(input.outcome)
    const outcomeObservedAt = dispatchInboxOutcomeObservedAt(input.outcome)

    const persisted = yield* transaction.transact(
      `governed-action.execution-persist-${input.operation}`,
      Effect.gen(function*() {
        const now = DateTime.makeUnsafe(yield* clock.currentTimeMillis)
        const lease = yield* readLease(permitTokenDigest, input.operation)
        const existing = yield* readExisting(permitTokenDigest, input.operation)
        const expected = {
          workspaceId: lease.workspaceId,
          actionId: lease.actionId,
          resultKind,
          outcomeJson: encoded.outcomeJson,
          outcomeDigest: encoded.outcomeDigest,
          commandDigest
        }
        if (existing !== undefined) {
          if (!outcomeMatches(existing, expected)) return yield* storeError(input.operation, "conflict")
          return { lease, outcomeId: existing.outcomeId }
        }

        if (
          DateTime.Order(input.receivedAt, now) > 0 ||
          DateTime.Order(outcomeObservedAt, input.receivedAt) > 0 ||
          DateTime.Order(outcomeObservedAt, lease.createdAt) < 0 ||
          (resultKind !== "manual-unknown" && DateTime.Order(outcomeObservedAt, lease.dispatchDeadline) >= 0) ||
          DateTime.Order(input.receivedAt, lease.leaseExpiresAt) >= 0 ||
          lease.recoveryClaimCount !== 0
        ) return yield* storeError(input.operation, "conflict")

        const record = yield* transaction.read({
          workspaceId: lease.workspaceId,
          actionId: lease.actionId
        })
        if (record.head.state !== "started" && record.head.state !== "cancel-requested") {
          return yield* storeError(input.operation, "conflict")
        }

        const outcomeId = yield* cryptoService.randomUUIDv7
        yield* sql`INSERT INTO governed_action_provider_outcomes (
          workspace_id, action_id, outcome_id, source_kind, permit_token_digest,
          recovery_claim_token_digest, result_kind, schema_version, outcome_json,
          outcome_digest, expected_command_digest, observed_at, received_at
        ) VALUES (
          ${lease.workspaceId}, ${lease.actionId}, ${outcomeId}, 'dispatch', ${permitTokenDigest},
          NULL, ${resultKind}, 1, ${encoded.outcomeJson}, ${encoded.outcomeDigest},
          ${commandDigest}, ${DateTime.formatIso(outcomeObservedAt)}, ${DateTime.formatIso(input.receivedAt)}
        )`
        return { lease, outcomeId }
      })
    ).pipe(Effect.mapError(mapFailure))

    return yield* folder.foldExpected(input.operation, {
      workspaceId: persisted.lease.workspaceId,
      actionId: persisted.lease.actionId,
      outcomeId: persisted.outcomeId,
      sourceKind: "dispatch",
      sourceTokenDigest: permitTokenDigest,
      resultKind,
      outcomeJson: encoded.outcomeJson,
      outcomeDigest: encoded.outcomeDigest,
      observedAt: outcomeObservedAt,
      commandDigest
    })
  })

  return { recordOutcome }
})
