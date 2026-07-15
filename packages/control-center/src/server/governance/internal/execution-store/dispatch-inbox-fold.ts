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
  dispatchInboxOutcomeCommand,
  dispatchInboxOutcomeKind,
  dispatchInboxOutcomeObservedAt,
  DispatchResultKind,
  encodeDispatchInboxOutcome
} from "./dispatch-outcome.js"
import { GovernedActionPermitTokenDigest } from "./tokens.js"

type DispatchInboxFoldOperation = "inspect" | "record-dispatch" | "record-unknown"

interface ExpectedDispatchInboxOutcome {
  readonly actionId: GovernedActionId
  readonly commandDigest: typeof GovernedActionCommandDigest.Type
  readonly outcomeDigest: string
  readonly outcomeId: string
  readonly outcomeJson: string
  readonly permitTokenDigest: GovernedActionPermitTokenDigest
  readonly resultKind: typeof DispatchResultKind.Type
  readonly workspaceId: WorkspaceId
}

const DispatchInboxRow = Schema.Struct({
  workspaceId: WorkspaceId,
  actionId: GovernedActionId,
  outcomeId: Schema.String,
  permitTokenDigest: GovernedActionPermitTokenDigest,
  resultKind: DispatchResultKind,
  outcomeJson: Schema.String,
  outcomeDigest: Schema.String.check(
    Schema.isPattern(/^[0-9a-f]{64}$/u, { expected: "a lowercase SHA-256 digest" })
  ),
  expectedCommandDigest: GovernedActionCommandDigest,
  observedAt: UtcTimestamp,
  receivedAt: UtcTimestamp,
  foldTransitionId: Schema.NullOr(GovernedActionTransitionId)
})

const storeError = (
  operation: DispatchInboxFoldOperation,
  reason: GovernedActionExecutionStoreError["reason"]
): GovernedActionExecutionStoreError => new GovernedActionExecutionStoreError({ operation, reason })

const mapStoreFailure = (
  operation: DispatchInboxFoldOperation,
  failure: unknown
): GovernedActionExecutionStoreError => {
  if (Schema.is(GovernedActionExecutionStoreError)(failure)) return failure
  if (Predicate.isTagged("RecordNotFoundError")(failure)) return storeError(operation, "not-found")
  if (Predicate.isTagged("PersistedRecordError")(failure)) return storeError(operation, "invalid-record")
  if (Predicate.isTagged("GovernedActionInputError")(failure)) return storeError(operation, "conflict")
  return storeError(operation, "persistence-unavailable")
}

const expectedMatches = (
  row: typeof DispatchInboxRow.Type,
  expected: ExpectedDispatchInboxOutcome
): boolean =>
  row.workspaceId === expected.workspaceId &&
  row.actionId === expected.actionId &&
  row.outcomeId === expected.outcomeId &&
  row.permitTokenDigest === expected.permitTokenDigest &&
  row.resultKind === expected.resultKind &&
  row.outcomeJson === expected.outcomeJson &&
  row.outcomeDigest === expected.outcomeDigest &&
  row.expectedCommandDigest === expected.commandDigest

/** Own canonical verification and lifecycle folding for both immediate and restart inbox paths. */
export const makeGovernedActionExecutionDispatchInboxFolder = Effect.gen(function*() {
  const { sql } = yield* Database
  const clock = yield* Clock.Clock
  const cryptoService = yield* Crypto.Crypto
  const transaction = yield* makeGovernedActionTransaction
  const writer = yield* makeGovernedActionTransactionWrite

  const decodeRows = Effect.fn("GovernedActionExecutionDispatchInboxFolder.decodeRows")(function*(
    rows: ReadonlyArray<unknown>,
    operation: DispatchInboxFoldOperation
  ) {
    return yield* Schema.decodeUnknownEffect(Schema.Array(DispatchInboxRow))(rows).pipe(
      Effect.mapError(() => storeError(operation, "invalid-record"))
    )
  })

  const foldRow = Effect.fn("GovernedActionExecutionDispatchInboxFolder.foldRow")(function*(
    row: typeof DispatchInboxRow.Type,
    operation: DispatchInboxFoldOperation
  ) {
    const mapFailure = (failure: unknown): GovernedActionExecutionStoreError => mapStoreFailure(operation, failure)
    const outcome = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(DispatchInboxOutcome)
    )(row.outcomeJson).pipe(Effect.mapError(() => storeError(operation, "invalid-record")))
    const command = dispatchInboxOutcomeCommand(outcome)
    const encoded = yield* encodeDispatchInboxOutcome(outcome).pipe(
      Effect.provideService(Crypto.Crypto, cryptoService),
      Effect.mapError(mapFailure)
    )
    const commandDigest = yield* digestGovernedActionTransitionCommand(command).pipe(
      Effect.provideService(Crypto.Crypto, cryptoService),
      Effect.mapError(mapFailure)
    )
    if (
      row.resultKind !== dispatchInboxOutcomeKind(outcome) ||
      row.outcomeJson !== encoded.outcomeJson ||
      row.outcomeDigest !== encoded.outcomeDigest ||
      row.expectedCommandDigest !== commandDigest ||
      DateTime.Order(row.observedAt, dispatchInboxOutcomeObservedAt(outcome)) !== 0
    ) return yield* storeError(operation, "invalid-record")

    const record = yield* transaction.read({ workspaceId: row.workspaceId, actionId: row.actionId })
    if (row.foldTransitionId !== null) return record.head.state
    if (record.head.state !== "started" && record.head.state !== "cancel-requested") {
      return yield* storeError(operation, "conflict")
    }
    const foldedAt = DateTime.makeUnsafe(yield* clock.currentTimeMillis)
    if (DateTime.Order(foldedAt, row.receivedAt) < 0) return yield* storeError(operation, "conflict")

    const commit = yield* Schema.decodeUnknownEffect(Schema.toType(GovernedActionCommitInput))({
      envelope: record.envelope,
      expectedHeadTransitionId: record.headTransition.transitionId,
      transitionId: GovernedActionTransitionId.make(yield* cryptoService.randomUUIDv7),
      commandId: GovernedActionCommandId.make(`execution:dispatch:${row.permitTokenDigest}`),
      command,
      cause: { _tag: "system", component: "governed-action-execution" },
      occurredAt: foldedAt,
      causationId: record.envelope.causationId,
      correlationId: record.envelope.correlationId,
      companion: { _tag: "none" },
      auditEventId: DomainEventId.make(yield* cryptoService.randomUUIDv7)
    })
    const committed = yield* writer.commit(commit)
    yield* sql`INSERT INTO governed_action_provider_outcome_folds (
      workspace_id, action_id, outcome_id, transition_id, folded_at
    ) VALUES (
      ${row.workspaceId}, ${row.actionId}, ${row.outcomeId},
      ${committed.transition.transitionId}, ${DateTime.formatIso(foldedAt)}
    )`
    return committed.transition.toState
  })

  const foldExpected = Effect.fn("GovernedActionExecutionDispatchInboxFolder.foldExpected")(function*(
    operation: Exclude<DispatchInboxFoldOperation, "inspect">,
    expected: ExpectedDispatchInboxOutcome
  ) {
    return yield* transaction.transact(
      `governed-action.execution-fold-${operation}`,
      Effect.gen(function*() {
        const rows = yield* sql`SELECT
          outcome.workspace_id AS workspaceId,
          outcome.action_id AS actionId,
          outcome.outcome_id AS outcomeId,
          outcome.permit_token_digest AS permitTokenDigest,
          outcome.result_kind AS resultKind,
          outcome.outcome_json AS outcomeJson,
          outcome.outcome_digest AS outcomeDigest,
          outcome.expected_command_digest AS expectedCommandDigest,
          outcome.observed_at AS observedAt,
          outcome.received_at AS receivedAt,
          fold.transition_id AS foldTransitionId
        FROM governed_action_provider_outcomes outcome
        LEFT JOIN governed_action_provider_outcome_folds fold
          ON fold.workspace_id = outcome.workspace_id
          AND fold.action_id = outcome.action_id
          AND fold.outcome_id = outcome.outcome_id
        WHERE outcome.permit_token_digest = ${expected.permitTokenDigest}
        LIMIT 2`
        const decoded = yield* decodeRows(rows, operation)
        const row = decoded[0]
        if (decoded.length !== 1 || row === undefined || !expectedMatches(row, expected)) {
          return yield* storeError(operation, "invalid-record")
        }
        return yield* foldRow(row, operation)
      })
    ).pipe(Effect.mapError((failure) => mapStoreFailure(operation, failure)))
  })

  const foldPending = Effect.fn("GovernedActionExecutionDispatchInboxFolder.foldPending")(function*(
    reference: GovernedActionExecutionReference
  ) {
    return yield* transaction.transact(
      "governed-action.execution-fold-pending-dispatch",
      Effect.gen(function*() {
        const rows = yield* sql`SELECT
          outcome.workspace_id AS workspaceId,
          outcome.action_id AS actionId,
          outcome.outcome_id AS outcomeId,
          outcome.permit_token_digest AS permitTokenDigest,
          outcome.result_kind AS resultKind,
          outcome.outcome_json AS outcomeJson,
          outcome.outcome_digest AS outcomeDigest,
          outcome.expected_command_digest AS expectedCommandDigest,
          outcome.observed_at AS observedAt,
          outcome.received_at AS receivedAt,
          fold.transition_id AS foldTransitionId
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
        const decoded = yield* decodeRows(rows, "inspect")
        if (decoded.length === 0) return null
        const row = decoded[0]
        if (decoded.length !== 1 || row === undefined) return yield* storeError("inspect", "invalid-record")
        return yield* foldRow(row, "inspect")
      })
    ).pipe(Effect.mapError((failure) => mapStoreFailure("inspect", failure)))
  })

  return { foldExpected, foldPending }
})
