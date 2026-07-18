import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"

import type { WorkspaceId } from "../../../../domain/identifiers.js"
import type { UtcTimestamp } from "../../../../domain/utcTimestamp.js"
import { Database } from "../../../persistence/Database.js"
import { readChanges } from "../../../persistence/repositories/internal.js"
import { GovernedActionExecutionStoreError } from "../GovernedActionExecutionStore.js"

const expiryFailure = (): GovernedActionExecutionStoreError =>
  new GovernedActionExecutionStoreError({
    operation: "expire-recovery-claims",
    reason: "persistence-unavailable"
  })

/** Append shutdown expirations for every still-live recovery claim in one workspace. */
export const makeGovernedActionRecoveryClaimExpiry = Effect.fn(
  "GovernedActionRecoveryClaimExpiry.make"
)(function*(workspaceId: WorkspaceId) {
  const { sql } = yield* Database

  const expire = Effect.fn("GovernedActionRecoveryClaimExpiry.expire")(function*(expiredAt: UtcTimestamp) {
    const timestamp = DateTime.formatIso(expiredAt)
    yield* sql`INSERT INTO governed_action_recovery_claim_expirations (
      workspace_id, action_id, claim_sequence, expired_at, reason
    )
    SELECT claim.workspace_id, claim.action_id, claim.claim_sequence, ${timestamp}, 'shutdown'
    FROM governed_action_recovery_claims claim
    WHERE claim.workspace_id = ${workspaceId}
      AND claim.claimed_at <= ${timestamp}
      AND ${timestamp} < claim.lease_expires_at
      AND NOT EXISTS (
        SELECT 1
        FROM governed_action_recovery_claim_expirations expiration
        WHERE expiration.workspace_id = claim.workspace_id
          AND expiration.action_id = claim.action_id
          AND expiration.claim_sequence = claim.claim_sequence
      )`
    return yield* readChanges(sql)
  }, Effect.mapError(expiryFailure))

  return { expire }
})
