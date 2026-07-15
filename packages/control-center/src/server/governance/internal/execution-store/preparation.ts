import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

import { GovernedActionEnvelopeDigest } from "../../../../domain/governedAction/index.js"
import { GovernedActionId, GovernedActionTransitionId, WorkspaceId } from "../../../../domain/identifiers.js"
import { UtcTimestamp } from "../../../../domain/utcTimestamp.js"
import { Database } from "../../../persistence/Database.js"
import { PersistedRecordError, RecordNotFoundError } from "../../../persistence/errors.js"
import { readChanges } from "../../../persistence/repositories/internal.js"
import { GovernedActionPreparationTokenDigest } from "./tokens.js"

const PreparationRow = Schema.Struct({
  preparationTokenDigest: GovernedActionPreparationTokenDigest,
  workspaceId: WorkspaceId,
  actionId: GovernedActionId,
  expectedHeadTransitionId: GovernedActionTransitionId,
  expectedEnvelopeDigest: GovernedActionEnvelopeDigest,
  createdAt: UtcTimestamp,
  expiresAt: UtcTimestamp
})

export type GovernedActionExecutionPreparationRow = typeof PreparationRow.Type

/** Exact preparation lookup for the transaction that converts inspection into durable intent. */
export const makeGovernedActionExecutionPreparationReader = Effect.gen(function*() {
  const { sql } = yield* Database

  const read = Effect.fn("GovernedActionExecutionPreparationReader.read")(function*(input: {
    readonly workspaceId: WorkspaceId
    readonly preparationTokenDigest: GovernedActionPreparationTokenDigest
  }) {
    const rows = yield* sql`SELECT
      preparation_token_digest AS preparationTokenDigest,
      workspace_id AS workspaceId,
      action_id AS actionId,
      expected_head_transition_id AS expectedHeadTransitionId,
      expected_envelope_digest AS expectedEnvelopeDigest,
      created_at AS createdAt,
      expires_at AS expiresAt
    FROM governed_action_execution_preparations
    WHERE workspace_id = ${input.workspaceId}
      AND preparation_token_digest = ${input.preparationTokenDigest}
    LIMIT 2`
    if (rows.length === 0) {
      return yield* new RecordNotFoundError({
        workspaceId: input.workspaceId,
        recordKind: "governed-action-execution-preparation",
        recordKey: input.preparationTokenDigest
      })
    }
    if (rows.length !== 1) {
      return yield* new PersistedRecordError({
        workspaceId: input.workspaceId,
        recordKind: "governed-action-execution-preparation",
        recordKey: input.preparationTokenDigest,
        diagnosticCode: "governed-action-execution-preparation-cardinality-invalid"
      })
    }
    return yield* Schema.decodeUnknownEffect(PreparationRow)(rows[0]).pipe(
      Effect.mapError(() =>
        new PersistedRecordError({
          workspaceId: input.workspaceId,
          recordKind: "governed-action-execution-preparation",
          recordKey: input.preparationTokenDigest,
          diagnosticCode: "governed-action-execution-preparation-schema-invalid"
        })
      )
    )
  })

  const consume = Effect.fn("GovernedActionExecutionPreparationReader.consume")(function*(
    preparation: GovernedActionExecutionPreparationRow
  ) {
    yield* sql`DELETE FROM governed_action_execution_preparations
      WHERE workspace_id = ${preparation.workspaceId}
        AND action_id = ${preparation.actionId}
        AND preparation_token_digest = ${preparation.preparationTokenDigest}
        AND expected_head_transition_id = ${preparation.expectedHeadTransitionId}
        AND expected_envelope_digest = ${preparation.expectedEnvelopeDigest}`
    return (yield* readChanges(sql)) === 1
  })

  return { consume, read }
})
