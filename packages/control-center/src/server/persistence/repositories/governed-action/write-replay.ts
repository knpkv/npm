import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

import {
  digestGovernedActionTransition,
  verifyGovernedActionTransition
} from "../../../governance/governedActionDigests.js"
import type { GovernedActionQuarantineRecordKind } from "./codec.js"
import type { GovernedActionCommitInput, GovernedActionCommitResult } from "./contract.js"
import {
  causeColumns,
  CauseJson,
  CommandJson,
  encodeJson,
  encodeTimestamp,
  inputError,
  persistedError,
  type PreparedCompanion,
  TransitionJson
} from "./write-preparation.js"

export const GovernedActionReplayRow = Schema.Struct({
  transitionId: Schema.String,
  previousTransitionId: Schema.NullOr(Schema.String),
  commandId: Schema.String,
  commandDigest: Schema.String,
  transitionDigest: Schema.String,
  transitionJson: Schema.String,
  linkedPolicyEvaluationDigest: Schema.NullOr(Schema.String),
  auditEventId: Schema.NullOr(Schema.String),
  auditEventKind: Schema.NullOr(Schema.String),
  auditCauseKind: Schema.NullOr(Schema.String),
  auditActorId: Schema.NullOr(Schema.String),
  auditSessionId: Schema.NullOr(Schema.String),
  auditJobId: Schema.NullOr(Schema.String),
  auditSystemComponent: Schema.NullOr(Schema.String),
  auditCausationId: Schema.NullOr(Schema.String),
  auditCorrelationId: Schema.NullOr(Schema.String),
  auditPayloadDigest: Schema.NullOr(Schema.String),
  auditPayloadJson: Schema.NullOr(Schema.String),
  auditOccurredAt: Schema.NullOr(Schema.String),
  authorizationDigest: Schema.NullOr(Schema.String),
  authorizationJson: Schema.NullOr(Schema.String),
  evaluationDigest: Schema.NullOr(Schema.String),
  evaluationJson: Schema.NullOr(Schema.String),
  attemptDigest: Schema.NullOr(Schema.String),
  attemptJson: Schema.NullOr(Schema.String),
  unownedEvaluationCount: Schema.Int
})

export type GovernedActionReplayRow = typeof GovernedActionReplayRow.Type

export const makeGovernedActionReplay = (cryptoService: Crypto.Crypto) => {
  const decodeRows = Effect.fn("GovernedActionWriter.decodeReplayRows")(function*(
    input: GovernedActionCommitInput,
    rows: ReadonlyArray<unknown>
  ) {
    return yield* Schema.decodeUnknownEffect(Schema.Array(GovernedActionReplayRow))(rows).pipe(
      Effect.mapError(() =>
        persistedError(
          input,
          "governed-action-transition",
          input.transitionId,
          "governed-action-transition-schema-invalid"
        )
      )
    )
  })

  const decodeTransition = Effect.fn("GovernedActionWriter.decodeTransition")(function*(
    input: GovernedActionCommitInput,
    json: string,
    recordKey: string
  ) {
    const transition = yield* Schema.decodeUnknownEffect(TransitionJson)(json).pipe(
      Effect.mapError(() =>
        persistedError(input, "governed-action-transition", recordKey, "governed-action-transition-schema-invalid")
      )
    )
    yield* verifyGovernedActionTransition(transition).pipe(
      Effect.provideService(Crypto.Crypto, cryptoService),
      Effect.mapError(() =>
        persistedError(input, "governed-action-transition", recordKey, "governed-action-transition-digest-mismatch")
      )
    )
    return transition
  })

  const resolve = Effect.fn("GovernedActionWriter.resolveReplay")(function*(
    input: GovernedActionCommitInput,
    commandDigest: string,
    commandJson: string,
    causeJson: string,
    companion: PreparedCompanion,
    rows: ReadonlyArray<GovernedActionReplayRow>
  ) {
    if (rows.length === 0) return null
    if (rows.length !== 1) return yield* inputError("changed-command-retry")

    const row = rows[0]
    if (row === undefined) return yield* inputError("changed-command-retry")
    const transition = yield* decodeTransition(input, row.transitionJson, row.transitionId)
    const storedCommandJson = yield* encodeJson(
      "governed-action.encode-replayed-command",
      CommandJson,
      transition.command
    ).pipe(
      Effect.mapError(() =>
        persistedError(
          input,
          "governed-action-transition",
          row.transitionId,
          "governed-action-transition-schema-invalid"
        )
      )
    )
    const storedCauseJson = yield* encodeJson(
      "governed-action.encode-replayed-cause",
      CauseJson,
      transition.cause
    ).pipe(
      Effect.mapError(() =>
        persistedError(
          input,
          "governed-action-transition",
          row.transitionId,
          "governed-action-transition-schema-invalid"
        )
      )
    )
    const occurredAt = yield* encodeTimestamp("governed-action.encode-replayed-time", transition.occurredAt).pipe(
      Effect.mapError(() =>
        persistedError(
          input,
          "governed-action-transition",
          row.transitionId,
          "governed-action-transition-schema-invalid"
        )
      )
    )

    if (
      row.transitionId !== input.transitionId ||
      row.previousTransitionId !== input.expectedHeadTransitionId ||
      row.commandId !== input.commandId ||
      row.commandDigest !== commandDigest ||
      transition.workspaceId !== input.envelope.workspaceId ||
      transition.actionId !== input.envelope.actionId ||
      transition.actionEnvelopeDigest !== input.envelope.envelopeDigest ||
      storedCommandJson !== commandJson ||
      storedCauseJson !== causeJson ||
      occurredAt !== (yield* encodeTimestamp("governed-action.encode-command-time", input.occurredAt)) ||
      transition.causationId !== input.causationId ||
      transition.correlationId !== input.correlationId
    ) {
      return yield* inputError("changed-command-retry")
    }

    const companionMissing = (recordKind: GovernedActionQuarantineRecordKind) =>
      persistedError(input, recordKind, row.transitionId, "governed-action-companion-invalid")
    if (row.unownedEvaluationCount !== 0) {
      return yield* companionMissing("governed-action-policy-evaluation")
    }
    switch (companion._tag) {
      case "none":
        if (
          row.linkedPolicyEvaluationDigest !== null ||
          row.authorizationDigest !== null ||
          row.authorizationJson !== null ||
          row.evaluationDigest !== null ||
          row.evaluationJson !== null ||
          row.attemptDigest !== null ||
          row.attemptJson !== null
        ) {
          return yield* inputError("changed-command-retry")
        }
        break
      case "authorization":
        if (row.authorizationDigest === null || row.authorizationJson === null) {
          return yield* companionMissing("governed-action-authorization")
        }
        if (row.authorizationDigest !== companion.digest || row.authorizationJson !== companion.json) {
          return yield* inputError("changed-command-retry")
        }
        break
      case "policyDenial":
        if (row.linkedPolicyEvaluationDigest === null) {
          return yield* inputError("changed-command-retry")
        }
        if (row.evaluationDigest === null || row.evaluationJson === null) {
          return yield* companionMissing("governed-action-policy-evaluation")
        }
        if (
          row.linkedPolicyEvaluationDigest !== companion.evaluationDigest ||
          row.evaluationDigest !== companion.evaluationDigest ||
          row.evaluationJson !== companion.evaluationJson
        ) {
          return yield* inputError("changed-command-retry")
        }
        break
      case "dispatch":
        if (
          row.linkedPolicyEvaluationDigest !== null ||
          row.evaluationDigest === null ||
          row.evaluationJson === null ||
          row.attemptDigest === null ||
          row.attemptJson === null
        ) {
          return yield* companionMissing("governed-action-attempt")
        }
        if (
          row.evaluationDigest !== companion.evaluationDigest ||
          row.evaluationJson !== companion.evaluationJson ||
          row.attemptDigest !== companion.attemptDigest ||
          row.attemptJson !== companion.attemptJson
        ) {
          return yield* inputError("changed-command-retry")
        }
        break
    }

    if (
      row.auditEventId === null ||
      row.auditEventKind === null ||
      row.auditCauseKind === null ||
      row.auditPayloadDigest === null ||
      row.auditPayloadJson === null ||
      row.auditOccurredAt === null
    ) {
      return yield* persistedError(
        input,
        "governed-action-transition",
        row.transitionId,
        "governed-action-audit-mismatch"
      )
    }
    if (row.auditEventId !== input.auditEventId) return yield* inputError("changed-command-retry")

    const transitionDigest = yield* digestGovernedActionTransition(transition).pipe(
      Effect.provideService(Crypto.Crypto, cryptoService),
      Effect.mapError(() =>
        persistedError(
          input,
          "governed-action-transition",
          row.transitionId,
          "governed-action-transition-digest-mismatch"
        )
      )
    )
    const auditTransition = yield* decodeTransition(input, row.auditPayloadJson, row.transitionId)
    const canonicalTransition = yield* encodeJson(
      "governed-action.encode-replayed-transition",
      TransitionJson,
      transition
    ).pipe(
      Effect.mapError(() =>
        persistedError(
          input,
          "governed-action-transition",
          row.transitionId,
          "governed-action-transition-schema-invalid"
        )
      )
    )
    const canonicalAuditTransition = yield* encodeJson(
      "governed-action.encode-replayed-audit",
      TransitionJson,
      auditTransition
    ).pipe(
      Effect.mapError(() =>
        persistedError(input, "governed-action-audit", row.transitionId, "governed-action-audit-mismatch")
      )
    )
    const cause = causeColumns(transition.cause)

    if (
      row.transitionDigest !== transitionDigest ||
      row.auditPayloadDigest !== transitionDigest ||
      canonicalAuditTransition !== canonicalTransition ||
      row.auditEventKind !== transition.toState ||
      row.auditCauseKind !== cause.kind ||
      row.auditActorId !== cause.actorId ||
      row.auditSessionId !== cause.sessionId ||
      row.auditJobId !== cause.jobId ||
      row.auditSystemComponent !== cause.systemComponent ||
      row.auditCausationId !== transition.causationId ||
      row.auditCorrelationId !== transition.correlationId ||
      row.auditOccurredAt !== occurredAt
    ) {
      return yield* persistedError(
        input,
        "governed-action-audit",
        row.transitionId,
        "governed-action-audit-mismatch"
      )
    }
    const result: GovernedActionCommitResult = { _tag: "replayed", transition }
    return result
  })

  return { decodeRows, resolve }
}
