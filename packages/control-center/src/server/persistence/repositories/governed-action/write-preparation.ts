import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

import { UtcTimestamp } from "../../../../domain/utcTimestamp.js"
import {
  digestGovernedActionAttempt,
  digestGovernedActionAuthorization,
  digestGovernedActionPolicyEvaluation
} from "../../../governance/governedActionDigests.js"
import { PersistedRecordError, PersistenceOperationError } from "../../errors.js"
import {
  GovernedActionAttemptJson,
  GovernedActionAuthorizationJson,
  GovernedActionCauseJson,
  GovernedActionCommandJson,
  GovernedActionEnvelopeJson,
  GovernedActionLineageJson,
  GovernedActionPolicyEvaluationJson,
  type GovernedActionQuarantineReasonCode,
  type GovernedActionQuarantineRecordKind,
  GovernedActionTransitionJson,
  projectGovernedActionCause,
  projectGovernedActionCommand,
  projectGovernedActionLineage
} from "./codec.js"
import type { GovernedActionCommitCompanion, GovernedActionCommitInput } from "./contract.js"
import { GovernedActionInputError } from "./contract.js"

export const EnvelopeJson = GovernedActionEnvelopeJson
export const TransitionJson = GovernedActionTransitionJson
const AuthorizationJson = GovernedActionAuthorizationJson
const PolicyEvaluationJson = GovernedActionPolicyEvaluationJson
const AttemptJson = GovernedActionAttemptJson
export const CommandJson = GovernedActionCommandJson
export const CauseJson = GovernedActionCauseJson
export const LineageJson = GovernedActionLineageJson

interface PreparedCompanionNone {
  readonly _tag: "none"
}

interface PreparedCompanionAuthorization {
  readonly _tag: "authorization"
  readonly value: GovernedActionCommitCompanion & { readonly _tag: "authorization" }
  readonly digest: string
  readonly json: string
  readonly authorizedAt: string
  readonly expiresAt: string
}

interface PreparedCompanionDispatch {
  readonly _tag: "dispatch"
  readonly value: Extract<GovernedActionCommitCompanion, { readonly _tag: "dispatch" }>
  readonly evaluationDigest: string
  readonly evaluationJson: string
  readonly evaluatedAt: string
  readonly attemptDigest: string
  readonly attemptJson: string
  readonly startedAt: string
}

interface PreparedCompanionPolicyDenial {
  readonly _tag: "policyDenial"
  readonly value: Extract<GovernedActionCommitCompanion, { readonly _tag: "policyDenial" }>
  readonly evaluationDigest: string
  readonly evaluationJson: string
  readonly evaluatedAt: string
}

export type PreparedCompanion =
  | PreparedCompanionNone
  | PreparedCompanionAuthorization
  | PreparedCompanionDispatch
  | PreparedCompanionPolicyDenial

interface CauseColumns {
  readonly kind: "human" | "agent" | "system"
  readonly actorId: string | null
  readonly sessionId: string | null
  readonly jobId: string | null
  readonly systemComponent: string | null
}

interface LineageColumns {
  readonly kind: "none" | "accepted" | "reconcilable" | "manual" | "terminal"
  readonly providerOperationId: string | null
  readonly reconciliationKey: string | null
  readonly terminalStatus: "succeeded" | "failed" | "cancelled" | null
}

export const persistedError = (
  input: GovernedActionCommitInput,
  recordKind: GovernedActionQuarantineRecordKind,
  recordKey: string,
  diagnosticCode: GovernedActionQuarantineReasonCode
) =>
  new PersistedRecordError({
    workspaceId: input.envelope.workspaceId,
    recordKind,
    recordKey,
    diagnosticCode
  })

export const inputError = (reason: GovernedActionInputError["reason"]) =>
  new GovernedActionInputError({ operation: "commit", reason })

export const encodeJson = <Value, Encoded, Requirements>(
  operation: string,
  codec: Schema.Codec<Value, Encoded, Requirements>,
  value: Value
) =>
  Schema.encodeEffect(codec)(value).pipe(
    Effect.mapError(() => new PersistenceOperationError({ operation }))
  )

export const encodeTimestamp = (operation: string, value: typeof UtcTimestamp.Type) =>
  encodeJson(operation, UtcTimestamp, value)

export const prepareCompanion = (cryptoService: Crypto.Crypto) =>
  Effect.fn("GovernedActionWriter.prepareCompanion")(function*(
    companion: GovernedActionCommitCompanion
  ): Effect.fn.Return<PreparedCompanion, GovernedActionInputError | PersistenceOperationError> {
    switch (companion._tag) {
      case "none":
        return { _tag: "none" }
      case "authorization":
        return {
          _tag: "authorization",
          value: companion,
          digest: yield* digestGovernedActionAuthorization(companion.authorization).pipe(
            Effect.provideService(Crypto.Crypto, cryptoService),
            Effect.mapError(() => new PersistenceOperationError({ operation: "governed-action.digest-authorization" }))
          ),
          json: yield* encodeJson(
            "governed-action.encode-authorization",
            AuthorizationJson,
            companion.authorization
          ),
          authorizedAt: yield* encodeTimestamp(
            "governed-action.encode-authorization-time",
            companion.authorization.authorizedAt
          ),
          expiresAt: yield* encodeTimestamp(
            "governed-action.encode-authorization-expiry",
            companion.authorization.expiresAt
          )
        }
      case "dispatch": {
        const attempt = companion.attempt
        const evaluationDigest = yield* digestGovernedActionPolicyEvaluation(companion.policyEvaluation).pipe(
          Effect.provideService(Crypto.Crypto, cryptoService),
          Effect.mapError(() => new PersistenceOperationError({ operation: "governed-action.digest-policy" }))
        )
        if (
          companion.policyEvaluation.decision !== "allowed" ||
          evaluationDigest !== attempt.policyEvaluationDigest
        ) {
          return yield* inputError("illegal-transition")
        }
        return {
          _tag: "dispatch",
          value: companion,
          evaluationDigest,
          evaluationJson: yield* encodeJson(
            "governed-action.encode-policy",
            PolicyEvaluationJson,
            companion.policyEvaluation
          ),
          evaluatedAt: yield* encodeTimestamp(
            "governed-action.encode-policy-time",
            companion.policyEvaluation.evaluatedAt
          ),
          attemptDigest: yield* digestGovernedActionAttempt(attempt).pipe(
            Effect.provideService(Crypto.Crypto, cryptoService),
            Effect.mapError(() => new PersistenceOperationError({ operation: "governed-action.digest-attempt" }))
          ),
          attemptJson: yield* encodeJson("governed-action.encode-attempt", AttemptJson, attempt),
          startedAt: yield* encodeTimestamp("governed-action.encode-attempt-time", attempt.startedAt)
        }
      }
      case "policyDenial":
        return {
          _tag: "policyDenial",
          value: companion,
          evaluationDigest: yield* digestGovernedActionPolicyEvaluation(companion.policyEvaluation).pipe(
            Effect.provideService(Crypto.Crypto, cryptoService),
            Effect.mapError(() => new PersistenceOperationError({ operation: "governed-action.digest-policy" }))
          ),
          evaluationJson: yield* encodeJson(
            "governed-action.encode-policy",
            PolicyEvaluationJson,
            companion.policyEvaluation
          ),
          evaluatedAt: yield* encodeTimestamp(
            "governed-action.encode-policy-time",
            companion.policyEvaluation.evaluatedAt
          )
        }
    }
  })

export const commandColumns = (command: GovernedActionCommitInput["command"]) => {
  const projection = projectGovernedActionCommand(command)
  return {
    authorizationId: projection.authorizationId,
    attemptId: projection.attemptId,
    outcomeSourceKind: projection.outcomeSourceKind,
    providerOperationId: projection.commandProviderOperationId,
    reconciliationKey: projection.commandReconciliationKey,
    terminalStatus: projection.commandTerminalStatus,
    unknownKind: projection.commandUnknownKind
  }
}

export const causeColumns = (cause: GovernedActionCommitInput["cause"]): CauseColumns => {
  const projection = projectGovernedActionCause(cause)
  return {
    kind: projection.causeKind,
    actorId: projection.causeActorId,
    sessionId: projection.causeSessionId,
    jobId: projection.causeJobId,
    systemComponent: projection.causeSystemComponent
  }
}

export const lineageColumns = (
  lineage: Parameters<typeof projectGovernedActionLineage>[0]
): LineageColumns => {
  const projection = projectGovernedActionLineage(lineage)
  return {
    kind: projection.lineageKind,
    providerOperationId: projection.providerOperationId,
    reconciliationKey: projection.reconciliationKey,
    terminalStatus: projection.terminalStatus
  }
}
