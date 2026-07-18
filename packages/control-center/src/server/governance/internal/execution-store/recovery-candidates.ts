import { renderGovernedActionRecoveryQuery } from "@knpkv/control-center-sql"
import * as Clock from "effect/Clock"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"

import { GovernedActionId, WorkspaceId } from "../../../../domain/identifiers.js"
import { Database } from "../../../persistence/Database.js"
import type { GovernedActionExecutionReference } from "../GovernedActionExecutionStore.js"
import { GovernedActionExecutionStoreError } from "../GovernedActionExecutionStore.js"

const RECOVERY_CANDIDATE_LIMIT = 64

const RecoveryCandidateRow = Schema.Struct({
  workspaceId: WorkspaceId,
  actionId: GovernedActionId
})

const listFailure = (failure: unknown): GovernedActionExecutionStoreError =>
  new GovernedActionExecutionStoreError({
    operation: "list-recovery",
    reason: Predicate.isTagged("SchemaError")(failure) ? "invalid-record" : "persistence-unavailable"
  })

/** Read one stable, bounded startup batch without claiming or executing any action. */
export const makeGovernedActionRecoveryCandidates = Effect.gen(function*() {
  const { sql } = yield* Database
  const clock = yield* Clock.Clock

  const list = Effect.fn("GovernedActionRecoveryCandidates.list")(function*() {
    const observedAt = DateTime.makeUnsafe(yield* clock.currentTimeMillis)
    const rendered = renderGovernedActionRecoveryQuery({
      limit: RECOVERY_CANDIDATE_LIMIT,
      observedAt: DateTime.formatIso(observedAt)
    })
    const rows = yield* sql.unsafe(rendered.sql, [...rendered.params])
    return yield* Schema.decodeUnknownEffect(
      Schema.Array(RecoveryCandidateRow)
    )(rows)
  }, Effect.mapError(listFailure))

  const recoveryCandidates: Effect.Effect<
    ReadonlyArray<GovernedActionExecutionReference>,
    GovernedActionExecutionStoreError
  > = list()
  return { recoveryCandidates }
})
