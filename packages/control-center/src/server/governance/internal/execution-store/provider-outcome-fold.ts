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
import type { GovernedActionRecord } from "../../../persistence/repositories/governed-action/contract.js"
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
  encodeDispatchInboxOutcome
} from "./dispatch-outcome.js"
import { governedActionReconciliationKey } from "./reconciliation-locator.js"
import {
  encodeReconciliationInboxOutcome,
  ReconciliationInboxOutcome,
  reconciliationInboxOutcomeCommand,
  reconciliationInboxOutcomeKind,
  reconciliationInboxOutcomeObservedAt
} from "./reconciliation-outcome.js"
import type { GovernedActionPermitTokenDigest, GovernedActionRecoveryTokenDigest } from "./tokens.js"

type ProviderOutcomeFoldOperation =
  | "inspect"
  | "record-dispatch"
  | "record-recovery-unavailable"
  | "record-reconciliation"
  | "record-unknown"

const ProviderOutcomeSourceKind = Schema.Literals(["dispatch", "reconciliation"])
const ProviderOutcomeResultKind = Schema.Literals([
  "accepted",
  "succeeded",
  "failed",
  "cancelled",
  "unknown",
  "manual-unknown",
  "pending",
  "recovery-unavailable"
])
const TokenDigest = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{64}$/u, { expected: "a lowercase SHA-256 digest" })
)

interface ExpectedProviderOutcome {
  readonly actionId: GovernedActionId
  readonly commandDigest: typeof GovernedActionCommandDigest.Type
  readonly outcomeDigest: string
  readonly outcomeId: string
  readonly outcomeJson: string
  readonly resultKind: typeof ProviderOutcomeResultKind.Type
  readonly sourceKind: typeof ProviderOutcomeSourceKind.Type
  readonly sourceTokenDigest: GovernedActionPermitTokenDigest | GovernedActionRecoveryTokenDigest
  readonly workspaceId: WorkspaceId
}

const ProviderOutcomeRow = Schema.Struct({
  workspaceId: WorkspaceId,
  actionId: GovernedActionId,
  outcomeId: Schema.String,
  sourceKind: ProviderOutcomeSourceKind,
  sourceTokenDigest: TokenDigest,
  resultKind: ProviderOutcomeResultKind,
  outcomeJson: Schema.String,
  outcomeDigest: TokenDigest,
  expectedCommandDigest: GovernedActionCommandDigest,
  observedAt: UtcTimestamp,
  receivedAt: UtcTimestamp,
  foldTransitionId: Schema.NullOr(GovernedActionTransitionId),
  foldCommandDigest: Schema.NullOr(GovernedActionCommandDigest)
})

type DecodedProviderOutcome =
  | { readonly _tag: "dispatch"; readonly outcome: DispatchInboxOutcome }
  | { readonly _tag: "reconciliation"; readonly outcome: ReconciliationInboxOutcome }

const storeError = (
  operation: ProviderOutcomeFoldOperation,
  reason: GovernedActionExecutionStoreError["reason"]
): GovernedActionExecutionStoreError => new GovernedActionExecutionStoreError({ operation, reason })

const mapStoreFailure = (
  operation: ProviderOutcomeFoldOperation,
  failure: unknown
): GovernedActionExecutionStoreError => {
  if (Schema.is(GovernedActionExecutionStoreError)(failure)) return failure
  if (Predicate.isTagged("RecordNotFoundError")(failure)) return storeError(operation, "not-found")
  if (Predicate.isTagged("PersistedRecordError")(failure)) return storeError(operation, "invalid-record")
  if (
    Predicate.isTagged("GovernedActionInputError")(failure) ||
    (operation !== "inspect" && Schema.isSchemaError(failure))
  ) return storeError(operation, "conflict")
  return storeError(operation, "persistence-unavailable")
}

const expectedMatches = (
  row: typeof ProviderOutcomeRow.Type,
  expected: ExpectedProviderOutcome
): boolean =>
  row.workspaceId === expected.workspaceId &&
  row.actionId === expected.actionId &&
  row.outcomeId === expected.outcomeId &&
  row.sourceKind === expected.sourceKind &&
  row.sourceTokenDigest === expected.sourceTokenDigest &&
  row.resultKind === expected.resultKind &&
  row.outcomeJson === expected.outcomeJson &&
  row.outcomeDigest === expected.outcomeDigest &&
  row.expectedCommandDigest === expected.commandDigest

const operationMatchesSource = (
  operation: Exclude<ProviderOutcomeFoldOperation, "inspect">,
  sourceKind: typeof ProviderOutcomeSourceKind.Type
): boolean =>
  sourceKind === "dispatch"
    ? operation === "record-dispatch" || operation === "record-unknown"
    : operation === "record-reconciliation" || operation === "record-recovery-unavailable"

const isFoldableState = (
  sourceKind: typeof ProviderOutcomeSourceKind.Type,
  state: string
): boolean =>
  sourceKind === "dispatch"
    ? state === "started" || state === "cancel-requested"
    : state === "started" ||
      state === "cancel-requested" ||
      state === "unknown" ||
      state === "cancel-requested-unknown"

const outcomeCommand = (
  decoded: DecodedProviderOutcome,
  record: GovernedActionRecord,
  observedAt: UtcTimestamp
) =>
  decoded._tag === "dispatch"
    ? dispatchInboxOutcomeCommand(decoded.outcome)
    : reconciliationInboxOutcomeCommand(
      decoded.outcome,
      governedActionReconciliationKey(record),
      observedAt
    )

/** Own every canonical verification, replay check, transaction, and fold for provider outcomes. */
export const makeGovernedActionExecutionProviderOutcomeFolder = Effect.gen(function*() {
  const { sql } = yield* Database
  const clock = yield* Clock.Clock
  const cryptoService = yield* Crypto.Crypto
  const transaction = yield* makeGovernedActionTransaction
  const writer = yield* makeGovernedActionTransactionWrite

  const decodeRows = Effect.fn("GovernedActionExecutionProviderOutcomeFolder.decodeRows")(function*(
    rows: ReadonlyArray<unknown>,
    operation: ProviderOutcomeFoldOperation
  ) {
    return yield* Schema.decodeUnknownEffect(Schema.Array(ProviderOutcomeRow))(rows).pipe(
      Effect.mapError(() => storeError(operation, "invalid-record"))
    )
  })

  const decodeAndVerify = Effect.fn(
    "GovernedActionExecutionProviderOutcomeFolder.decodeAndVerify"
  )(function*(
    row: typeof ProviderOutcomeRow.Type,
    operation: ProviderOutcomeFoldOperation
  ) {
    const mapFailure = (failure: unknown): GovernedActionExecutionStoreError => mapStoreFailure(operation, failure)
    if (row.sourceKind === "dispatch") {
      const outcome = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(DispatchInboxOutcome)
      )(row.outcomeJson).pipe(Effect.mapError(() => storeError(operation, "invalid-record")))
      const encoded = yield* encodeDispatchInboxOutcome(outcome).pipe(
        Effect.provideService(Crypto.Crypto, cryptoService),
        Effect.mapError(mapFailure)
      )
      if (
        row.resultKind !== dispatchInboxOutcomeKind(outcome) ||
        row.outcomeJson !== encoded.outcomeJson ||
        row.outcomeDigest !== encoded.outcomeDigest ||
        DateTime.Order(row.observedAt, dispatchInboxOutcomeObservedAt(outcome)) !== 0
      ) return yield* storeError(operation, "invalid-record")
      return { _tag: "dispatch", outcome } satisfies DecodedProviderOutcome
    }

    const outcome = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(ReconciliationInboxOutcome)
    )(row.outcomeJson).pipe(Effect.mapError(() => storeError(operation, "invalid-record")))
    const encoded = yield* encodeReconciliationInboxOutcome(outcome).pipe(
      Effect.provideService(Crypto.Crypto, cryptoService),
      Effect.mapError(mapFailure)
    )
    if (
      row.resultKind !== reconciliationInboxOutcomeKind(outcome) ||
      row.outcomeJson !== encoded.outcomeJson ||
      row.outcomeDigest !== encoded.outcomeDigest ||
      DateTime.Order(row.observedAt, reconciliationInboxOutcomeObservedAt(outcome, row.receivedAt)) !== 0
    ) return yield* storeError(operation, "invalid-record")
    return { _tag: "reconciliation", outcome } satisfies DecodedProviderOutcome
  })

  const foldRow = Effect.fn("GovernedActionExecutionProviderOutcomeFolder.foldRow")(function*(
    row: typeof ProviderOutcomeRow.Type,
    operation: ProviderOutcomeFoldOperation
  ) {
    const mapFailure = (failure: unknown): GovernedActionExecutionStoreError => mapStoreFailure(operation, failure)
    const decoded = yield* decodeAndVerify(row, operation)
    const record = yield* transaction.read({ workspaceId: row.workspaceId, actionId: row.actionId })
    if (row.foldTransitionId !== null) {
      if (row.foldCommandDigest !== row.expectedCommandDigest) {
        return yield* storeError(operation, "invalid-record")
      }
      return record.head.state
    }
    if (!isFoldableState(row.sourceKind, record.head.state)) {
      return yield* storeError(operation, "conflict")
    }
    const command = outcomeCommand(decoded, record, row.observedAt)
    const commandDigest = yield* digestGovernedActionTransitionCommand(command).pipe(
      Effect.provideService(Crypto.Crypto, cryptoService),
      Effect.mapError(mapFailure)
    )
    if (commandDigest !== row.expectedCommandDigest) return yield* storeError(operation, "invalid-record")

    const foldedAt = DateTime.makeUnsafe(yield* clock.currentTimeMillis)
    if (DateTime.Order(foldedAt, row.receivedAt) < 0) return yield* storeError(operation, "conflict")
    const commit = yield* Schema.decodeUnknownEffect(Schema.toType(GovernedActionCommitInput))({
      envelope: record.envelope,
      expectedHeadTransitionId: record.headTransition.transitionId,
      transitionId: yield* cryptoService.randomUUIDv7,
      commandId: `execution:${row.sourceKind}:${row.sourceTokenDigest}`,
      command,
      cause: { _tag: "system", component: "governed-action-execution" },
      occurredAt: foldedAt,
      causationId: record.envelope.causationId,
      correlationId: record.envelope.correlationId,
      companion: { _tag: "none" },
      auditEventId: yield* cryptoService.randomUUIDv7
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

  const selectColumns = sql`SELECT
    outcome.workspace_id AS workspaceId,
    outcome.action_id AS actionId,
    outcome.outcome_id AS outcomeId,
    outcome.source_kind AS sourceKind,
    CASE outcome.source_kind
      WHEN 'dispatch' THEN outcome.permit_token_digest
      ELSE outcome.recovery_claim_token_digest
    END AS sourceTokenDigest,
    outcome.result_kind AS resultKind,
    outcome.outcome_json AS outcomeJson,
    outcome.outcome_digest AS outcomeDigest,
    outcome.expected_command_digest AS expectedCommandDigest,
    outcome.observed_at AS observedAt,
    outcome.received_at AS receivedAt,
    fold.transition_id AS foldTransitionId,
    transition_record.command_digest AS foldCommandDigest
  FROM governed_action_provider_outcomes outcome
  LEFT JOIN governed_action_provider_outcome_folds fold
    ON fold.workspace_id = outcome.workspace_id
    AND fold.action_id = outcome.action_id
    AND fold.outcome_id = outcome.outcome_id
  LEFT JOIN governed_action_transitions transition_record
    ON transition_record.workspace_id = fold.workspace_id
    AND transition_record.action_id = fold.action_id
    AND transition_record.transition_id = fold.transition_id`

  const foldExpected = Effect.fn("GovernedActionExecutionProviderOutcomeFolder.foldExpected")(function*(
    operation: Exclude<ProviderOutcomeFoldOperation, "inspect">,
    expected: ExpectedProviderOutcome
  ) {
    if (!operationMatchesSource(operation, expected.sourceKind)) {
      return yield* storeError(operation, "conflict")
    }
    return yield* transaction.transact(
      `governed-action.execution-fold-${operation}`,
      Effect.gen(function*() {
        const rows = yield* sql`${selectColumns}
          WHERE outcome.source_kind = ${expected.sourceKind}
            AND CASE outcome.source_kind
              WHEN 'dispatch' THEN outcome.permit_token_digest
              ELSE outcome.recovery_claim_token_digest
            END = ${expected.sourceTokenDigest}
          LIMIT 2`
        const decoded = yield* decodeRows(rows, operation)
        const row = decoded[0]
        if (decoded.length !== 1 || row === undefined || !expectedMatches(row, expected)) {
          return yield* storeError(operation, "invalid-record")
        }
        return yield* foldRow(row, operation)
      }).pipe(
        Effect.catchIf(Schema.isSchemaError, () => storeError(operation, "conflict"))
      )
    ).pipe(Effect.mapError((failure) => mapStoreFailure(operation, failure)))
  })

  const foldPending = Effect.fn("GovernedActionExecutionProviderOutcomeFolder.foldPending")(function*(
    reference: GovernedActionExecutionReference
  ) {
    return yield* transaction.transact(
      "governed-action.execution-fold-pending-provider-outcome",
      Effect.gen(function*() {
        const rows = yield* sql`${selectColumns}
          WHERE outcome.workspace_id = ${reference.workspaceId}
            AND outcome.action_id = ${reference.actionId}
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
