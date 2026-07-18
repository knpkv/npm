import * as Clock from "effect/Clock"
import * as Crypto from "effect/Crypto"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"

import { GovernedActionCommandDigest } from "../../../../domain/governedAction/index.js"
import { GovernedActionId, WorkspaceId } from "../../../../domain/identifiers.js"
import { UtcTimestamp } from "../../../../domain/utcTimestamp.js"
import { Database } from "../../../persistence/Database.js"
import { makeGovernedActionTransaction } from "../../../persistence/repositories/governed-action/transaction.js"
import { digestGovernedActionTransitionCommand } from "../../governedActionDigests.js"
import { GovernedActionExecutionStoreError } from "../GovernedActionExecutionStore.js"
import { makeGovernedActionExecutionProviderOutcomeFolder } from "./provider-outcome-fold.js"
import { governedActionReconciliationKey } from "./reconciliation-locator.js"
import {
  encodeReconciliationInboxOutcome,
  type ReconciliationInboxOutcome,
  reconciliationInboxOutcomeCommand,
  reconciliationInboxOutcomeKind,
  reconciliationInboxOutcomeObservedAt,
  ReconciliationResultKind
} from "./reconciliation-outcome.js"
import {
  digestGovernedActionRecoveryToken,
  type GovernedActionRecoveryToken,
  type GovernedActionRecoveryTokenDigest
} from "./tokens.js"

type ReconciliationInboxOperation = "record-reconciliation" | "record-recovery-unavailable"

interface ReconciliationInboxInput {
  readonly operation: ReconciliationInboxOperation
  readonly outcome: ReconciliationInboxOutcome
  readonly receivedAt: UtcTimestamp
  readonly recoveryToken: GovernedActionRecoveryToken
}

const RecoveryClaimRow = Schema.Struct({
  workspaceId: WorkspaceId,
  actionId: GovernedActionId,
  claimSequence: Schema.Int.check(Schema.isGreaterThan(0)),
  claimedAt: UtcTimestamp,
  leaseExpiresAt: UtcTimestamp,
  expiredAt: Schema.NullOr(UtcTimestamp),
  latestClaimSequence: Schema.Int.check(Schema.isGreaterThan(0))
})

const ExistingOutcomeRow = Schema.Struct({
  workspaceId: WorkspaceId,
  actionId: GovernedActionId,
  outcomeId: Schema.String,
  resultKind: ReconciliationResultKind,
  outcomeJson: Schema.String,
  outcomeDigest: Schema.String.check(
    Schema.isPattern(/^[0-9a-f]{64}$/u, { expected: "a lowercase SHA-256 digest" })
  ),
  expectedCommandDigest: GovernedActionCommandDigest,
  observedAt: UtcTimestamp
})

const storeError = (
  operation: ReconciliationInboxOperation,
  reason: GovernedActionExecutionStoreError["reason"]
): GovernedActionExecutionStoreError => new GovernedActionExecutionStoreError({ operation, reason })

const mapStoreFailure = (
  operation: ReconciliationInboxOperation,
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

const existingMatches = (
  existing: typeof ExistingOutcomeRow.Type,
  expected: {
    readonly actionId: GovernedActionId
    readonly outcomeDigest: string
    readonly outcomeJson: string
    readonly observedAt: UtcTimestamp
    readonly resultKind: typeof ReconciliationResultKind.Type
    readonly workspaceId: WorkspaceId
  }
): boolean =>
  existing.workspaceId === expected.workspaceId &&
  existing.actionId === expected.actionId &&
  existing.resultKind === expected.resultKind &&
  existing.outcomeJson === expected.outcomeJson &&
  existing.outcomeDigest === expected.outcomeDigest &&
  DateTime.Order(existing.observedAt, expected.observedAt) === 0

const isRecoverableState = (state: string): boolean =>
  state === "started" ||
  state === "cancel-requested" ||
  state === "unknown" ||
  state === "cancel-requested-unknown"

/** Build the durable append-then-fold boundary shared by reconciliation-side outcomes. */
export const makeGovernedActionExecutionReconciliationInbox = Effect.gen(function*() {
  const { sql } = yield* Database
  const clock = yield* Clock.Clock
  const cryptoService = yield* Crypto.Crypto
  const transaction = yield* makeGovernedActionTransaction
  const folder = yield* makeGovernedActionExecutionProviderOutcomeFolder

  const readClaim = Effect.fn("GovernedActionExecutionReconciliationInbox.readClaim")(function*(
    recoveryTokenDigest: GovernedActionRecoveryTokenDigest,
    operation: ReconciliationInboxOperation
  ) {
    const rows = yield* sql`SELECT
      claim.workspace_id AS workspaceId,
      claim.action_id AS actionId,
      claim.claim_sequence AS claimSequence,
      claim.claimed_at AS claimedAt,
      claim.lease_expires_at AS leaseExpiresAt,
      expiration.expired_at AS expiredAt,
      (SELECT MAX(latest.claim_sequence)
        FROM governed_action_recovery_claims latest
        WHERE latest.workspace_id = claim.workspace_id
          AND latest.action_id = claim.action_id) AS latestClaimSequence
    FROM governed_action_recovery_claims claim
    LEFT JOIN governed_action_recovery_claim_expirations expiration
      ON expiration.workspace_id = claim.workspace_id
      AND expiration.action_id = claim.action_id
      AND expiration.claim_sequence = claim.claim_sequence
    WHERE claim.claim_token_digest = ${recoveryTokenDigest}
    LIMIT 2`
    const decoded = yield* Schema.decodeUnknownEffect(Schema.Array(RecoveryClaimRow))(rows).pipe(
      Effect.mapError(() => storeError(operation, "invalid-record"))
    )
    if (decoded.length === 0) return yield* storeError(operation, "not-found")
    const row = decoded[0]
    if (decoded.length !== 1 || row === undefined) return yield* storeError(operation, "invalid-record")
    return row
  })

  const readExisting = Effect.fn("GovernedActionExecutionReconciliationInbox.readExisting")(function*(
    recoveryTokenDigest: GovernedActionRecoveryTokenDigest,
    operation: ReconciliationInboxOperation
  ) {
    const rows = yield* sql`SELECT
      workspace_id AS workspaceId,
      action_id AS actionId,
      outcome_id AS outcomeId,
      result_kind AS resultKind,
      outcome_json AS outcomeJson,
      outcome_digest AS outcomeDigest,
      expected_command_digest AS expectedCommandDigest,
      observed_at AS observedAt
    FROM governed_action_provider_outcomes
    WHERE recovery_claim_token_digest = ${recoveryTokenDigest}
    LIMIT 2`
    const decoded = yield* Schema.decodeUnknownEffect(Schema.Array(ExistingOutcomeRow))(rows).pipe(
      Effect.mapError(() => storeError(operation, "invalid-record"))
    )
    if (decoded.length > 1) return yield* storeError(operation, "invalid-record")
    return decoded[0]
  })

  const recordOutcome = Effect.fn("GovernedActionExecutionReconciliationInbox.recordOutcome")(function*(
    input: ReconciliationInboxInput
  ) {
    const mapFailure = (failure: unknown): GovernedActionExecutionStoreError =>
      mapStoreFailure(input.operation, failure)
    const recoveryTokenDigest = yield* digestGovernedActionRecoveryToken(input.recoveryToken).pipe(
      Effect.provideService(Crypto.Crypto, cryptoService),
      Effect.mapError(mapFailure)
    )
    const encoded = yield* encodeReconciliationInboxOutcome(input.outcome).pipe(
      Effect.provideService(Crypto.Crypto, cryptoService),
      Effect.mapError(mapFailure)
    )
    const resultKind = reconciliationInboxOutcomeKind(input.outcome)
    const outcomeObservedAt = reconciliationInboxOutcomeObservedAt(input.outcome, input.receivedAt)

    const persisted = yield* transaction.transact(
      `governed-action.execution-persist-${input.operation}`,
      Effect.gen(function*() {
        const now = DateTime.makeUnsafe(yield* clock.currentTimeMillis)
        const claim = yield* readClaim(recoveryTokenDigest, input.operation)
        const existing = yield* readExisting(recoveryTokenDigest, input.operation)
        if (existing !== undefined) {
          if (
            !existingMatches(existing, {
              workspaceId: claim.workspaceId,
              actionId: claim.actionId,
              resultKind,
              outcomeJson: encoded.outcomeJson,
              outcomeDigest: encoded.outcomeDigest,
              observedAt: outcomeObservedAt
            })
          ) return yield* storeError(input.operation, "conflict")
          return {
            workspaceId: claim.workspaceId,
            actionId: claim.actionId,
            outcomeId: existing.outcomeId,
            commandDigest: existing.expectedCommandDigest
          }
        }

        if (
          DateTime.Order(input.receivedAt, now) > 0 ||
          DateTime.Order(outcomeObservedAt, input.receivedAt) > 0 ||
          DateTime.Order(outcomeObservedAt, claim.claimedAt) < 0 ||
          claim.expiredAt !== null ||
          DateTime.Order(input.receivedAt, claim.leaseExpiresAt) >= 0 ||
          claim.claimSequence !== claim.latestClaimSequence
        ) return yield* storeError(input.operation, "conflict")

        const record = yield* transaction.read({ workspaceId: claim.workspaceId, actionId: claim.actionId })
        if (!isRecoverableState(record.head.state)) return yield* storeError(input.operation, "conflict")
        const command = reconciliationInboxOutcomeCommand(
          input.outcome,
          governedActionReconciliationKey(record),
          outcomeObservedAt
        )
        const commandDigest = yield* digestGovernedActionTransitionCommand(command).pipe(
          Effect.provideService(Crypto.Crypto, cryptoService),
          Effect.mapError(mapFailure)
        )
        const outcomeId = yield* cryptoService.randomUUIDv7
        yield* sql`INSERT INTO governed_action_provider_outcomes (
          workspace_id, action_id, outcome_id, source_kind, permit_token_digest,
          recovery_claim_token_digest, result_kind, schema_version, outcome_json,
          outcome_digest, expected_command_digest, observed_at, received_at
        ) VALUES (
          ${claim.workspaceId}, ${claim.actionId}, ${outcomeId}, 'reconciliation', NULL,
          ${recoveryTokenDigest}, ${resultKind}, 1, ${encoded.outcomeJson}, ${encoded.outcomeDigest},
          ${commandDigest}, ${DateTime.formatIso(outcomeObservedAt)}, ${DateTime.formatIso(input.receivedAt)}
        )`
        return {
          workspaceId: claim.workspaceId,
          actionId: claim.actionId,
          outcomeId,
          commandDigest
        }
      })
    ).pipe(Effect.mapError(mapFailure))

    return yield* folder.foldExpected(input.operation, {
      workspaceId: persisted.workspaceId,
      actionId: persisted.actionId,
      outcomeId: persisted.outcomeId,
      sourceKind: "reconciliation",
      sourceTokenDigest: recoveryTokenDigest,
      resultKind,
      outcomeJson: encoded.outcomeJson,
      outcomeDigest: encoded.outcomeDigest,
      observedAt: outcomeObservedAt,
      commandDigest: persisted.commandDigest
    })
  })

  return { recordOutcome }
})
