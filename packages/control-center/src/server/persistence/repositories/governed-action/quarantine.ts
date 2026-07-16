import * as Effect from "effect/Effect"
import * as Predicate from "effect/Predicate"

import type { PersistedRecordError } from "../../errors.js"
import type { QuarantineDiagnosticSummary, QuarantineReasonCode, QuarantineRecordKind } from "../models.js"

type GovernedActionRecordKind = Extract<
  QuarantineRecordKind,
  | "governed-action"
  | "governed-action-policy-evaluation"
  | "governed-action-authorization"
  | "governed-action-attempt"
  | "governed-action-transition"
  | "governed-action-audit"
>

interface GovernedActionQuarantineDiagnostic {
  readonly diagnosticCode: QuarantineReasonCode
  readonly diagnosticSummary: QuarantineDiagnosticSummary
  readonly recordKind: GovernedActionRecordKind
}

/** Internal carrier retaining an untrusted row only until quarantine runs after rollback. */
export class MalformedGovernedActionRecord {
  readonly _tag = "MalformedGovernedActionRecord"
  readonly error: PersistedRecordError
  readonly row: unknown

  constructor(error: PersistedRecordError, row: unknown) {
    this.error = error
    this.row = row
  }
}

/** Attach an ephemeral raw row to a bounded persisted-record failure. */
export const captureMalformedGovernedActionRow =
  (row: unknown) => <Success, Failure, Requirements>(effect: Effect.Effect<Success, Failure, Requirements>) =>
    Effect.catchIf(
      effect,
      (failure): failure is Failure & PersistedRecordError => Predicate.isTagged("PersistedRecordError")(failure),
      (error) => Effect.fail(new MalformedGovernedActionRecord(error, row))
    )

/** Fixed, non-secret quarantine metadata for governed-action corruption. */
export const governedActionQuarantineDiagnostic = (
  error: PersistedRecordError
): GovernedActionQuarantineDiagnostic | null => {
  const diagnostic = (
    recordKind: GovernedActionRecordKind,
    diagnosticCode: QuarantineReasonCode,
    diagnosticSummary: QuarantineDiagnosticSummary
  ): GovernedActionQuarantineDiagnostic => ({ recordKind, diagnosticCode, diagnosticSummary })

  switch (error.diagnosticCode) {
    case "governed-action-schema-invalid":
      return diagnostic(
        "governed-action",
        error.diagnosticCode,
        "Stored governed action failed schema validation."
      )
    case "governed-action-digest-mismatch":
      return diagnostic(
        "governed-action",
        error.diagnosticCode,
        "Stored governed action digest does not match its content."
      )
    case "governed-action-identity-mismatch":
      return diagnostic(
        "governed-action",
        error.diagnosticCode,
        "Stored governed action identity does not match its repository key."
      )
    case "governed-action-chain-invalid":
      return diagnostic(
        "governed-action-transition",
        error.diagnosticCode,
        "Stored governed action transition chain is invalid."
      )
    case "governed-action-head-mismatch":
      return diagnostic(
        "governed-action",
        error.diagnosticCode,
        "Stored governed action head does not match its transition history."
      )
    case "governed-action-companion-invalid":
      return diagnostic(
        error.recordKind === "governed-action-policy-evaluation" ||
          error.recordKind === "governed-action-authorization" ||
          error.recordKind === "governed-action-attempt"
          ? error.recordKind
          : "governed-action",
        error.diagnosticCode,
        "Stored governed action authority companion is invalid."
      )
    case "governed-action-transition-schema-invalid":
      return diagnostic(
        "governed-action-transition",
        error.diagnosticCode,
        "Stored governed action transition failed schema validation."
      )
    case "governed-action-transition-digest-mismatch":
      return diagnostic(
        "governed-action-transition",
        error.diagnosticCode,
        "Stored governed action transition digest does not match its content."
      )
    case "governed-action-audit-mismatch":
      return diagnostic(
        "governed-action-audit",
        error.diagnosticCode,
        "Stored governed action audit record does not match its transition."
      )
    default:
      return null
  }
}
