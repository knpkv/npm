import * as Crypto from "effect/Crypto"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"

import { PluginActionReconciliationRequestV1 } from "../../../../domain/plugins/actions.js"
import { UtcTimestamp } from "../../../../domain/utcTimestamp.js"
import { Database } from "../../../persistence/Database.js"
import type { GovernedActionRecord } from "../../../persistence/repositories/governed-action/contract.js"
import { PluginRuntimeAuthorityToken } from "../../../plugins/internal/PluginRuntimeAuthority.js"
import type { GovernedActionRecoveryPreparation } from "../GovernedActionExecutionStore.js"
import { GovernedActionExecutionStoreError } from "../GovernedActionExecutionStore.js"
import { governedActionReconciliationKey } from "./reconciliation-locator.js"
import { GovernedActionRecoveryTokenDigest, issueGovernedActionRecoveryToken } from "./tokens.js"

const RECOVERY_CLAIM_SECONDS = 60

const RecoveryLeaseRow = Schema.Struct({
  runtimeAuthorityToken: PluginRuntimeAuthorityToken,
  recoveryEligibleAt: UtcTimestamp
})

const LatestRecoveryClaimRow = Schema.Struct({
  claimSequence: Schema.Int.check(Schema.isGreaterThan(0)),
  claimTokenDigest: GovernedActionRecoveryTokenDigest,
  leaseExpiresAt: UtcTimestamp
})

const storeFailure = (failure: unknown): GovernedActionExecutionStoreError => {
  if (Schema.is(GovernedActionExecutionStoreError)(failure)) return failure
  if (Predicate.isTagged("RecordNotFoundError")(failure)) {
    return new GovernedActionExecutionStoreError({ operation: "inspect", reason: "not-found" })
  }
  if (Predicate.isTagged("PersistedRecordError")(failure) || Predicate.isTagged("SchemaError")(failure)) {
    return new GovernedActionExecutionStoreError({ operation: "inspect", reason: "invalid-record" })
  }
  return new GovernedActionExecutionStoreError({ operation: "inspect", reason: "persistence-unavailable" })
}

const invalidRecord = (): GovernedActionExecutionStoreError =>
  new GovernedActionExecutionStoreError({ operation: "inspect", reason: "invalid-record" })

const isRecoverable = (record: GovernedActionRecord): boolean =>
  record.head.state === "started" ||
  record.head.state === "cancel-requested" ||
  record.head.state === "unknown" ||
  record.head.state === "cancel-requested-unknown"

/** Build atomic, expiring recovery claims over one transaction-owned aggregate snapshot. */
export const makeGovernedActionExecutionRecoveryClaim = Effect.gen(function*() {
  const { sql } = yield* Database
  const cryptoService = yield* Crypto.Crypto

  const claim = Effect.fn("GovernedActionExecutionRecoveryClaim.claim")(function*(
    record: GovernedActionRecord,
    observedAt: UtcTimestamp
  ) {
    if (!isRecoverable(record)) return null

    const leaseRows = yield* sql`SELECT
      runtime_authority_token AS runtimeAuthorityToken,
      recovery_eligible_at AS recoveryEligibleAt
    FROM governed_action_execution_leases
    WHERE workspace_id = ${record.envelope.workspaceId}
      AND action_id = ${record.envelope.actionId}
    LIMIT 2`
    const leases = yield* Schema.decodeUnknownEffect(Schema.Array(RecoveryLeaseRow))(leaseRows).pipe(
      Effect.mapError(invalidRecord)
    )
    const lease = leases[0]
    if (leases.length !== 1 || lease === undefined) return yield* invalidRecord()
    if (DateTime.Order(observedAt, lease.recoveryEligibleAt) < 0) return null

    const claimRows = yield* sql`SELECT
      claim_sequence AS claimSequence,
      claim_token_digest AS claimTokenDigest,
      lease_expires_at AS leaseExpiresAt
    FROM governed_action_recovery_claims
    WHERE workspace_id = ${record.envelope.workspaceId}
      AND action_id = ${record.envelope.actionId}
    ORDER BY claim_sequence DESC
    LIMIT 1`
    const claims = yield* Schema.decodeUnknownEffect(Schema.Array(LatestRecoveryClaimRow))(claimRows).pipe(
      Effect.mapError(invalidRecord)
    )
    const latest = claims[0]
    if (latest !== undefined && DateTime.Order(observedAt, latest.leaseExpiresAt) < 0) return null

    const issued = yield* issueGovernedActionRecoveryToken().pipe(
      Effect.provideService(Crypto.Crypto, cryptoService),
      Effect.mapError(storeFailure)
    )
    const claimSequence = (latest?.claimSequence ?? 0) + 1
    const reconciliationDeadline = DateTime.add(observedAt, { seconds: RECOVERY_CLAIM_SECONDS })
    yield* sql`INSERT INTO governed_action_recovery_claims (
      workspace_id, action_id, claim_sequence, claim_token_digest, claimed_at, lease_expires_at
    ) VALUES (
      ${record.envelope.workspaceId}, ${record.envelope.actionId}, ${claimSequence}, ${issued.digest},
      ${DateTime.formatIso(observedAt)}, ${DateTime.formatIso(reconciliationDeadline)}
    )`
    const request = yield* Schema.decodeUnknownEffect(Schema.toType(PluginActionReconciliationRequestV1))({
      reconciliationKey: governedActionReconciliationKey(record),
      idempotencyKey: record.envelope.idempotencyKey,
      payloadDigest: record.envelope.proposal.payloadDigest
    }).pipe(Effect.mapError(invalidRecord))

    return {
      _tag: "reconcile",
      recoveryToken: issued.token,
      runtimeAuthorityToken: lease.runtimeAuthorityToken,
      reconciliationDeadline,
      scope: {
        workspaceId: record.envelope.workspaceId,
        pluginConnectionId: record.envelope.pluginConnectionId
      },
      request
    } satisfies GovernedActionRecoveryPreparation
  }, Effect.mapError(storeFailure))

  return { claim }
})
