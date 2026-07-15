import * as Effect from "effect/Effect"
import * as Predicate from "effect/Predicate"

import type { PersistedRecordError } from "../../errors.js"
import type { QuarantineDiagnosticSummary, QuarantineReasonCode, QuarantineRecordKind } from "../models.js"

type ReadinessQuarantineRecordKind = Extract<
  QuarantineRecordKind,
  "readiness-assessment" | "readiness-environment-head" | "readiness-release-head" | "readiness-rule"
>

interface ReadinessQuarantineDiagnostic {
  readonly diagnosticCode: QuarantineReasonCode
  readonly diagnosticSummary: QuarantineDiagnosticSummary
  readonly recordKind: ReadinessQuarantineRecordKind
}

/** Internal carrier that keeps malformed readiness values out of the public error channel. */
export class MalformedReadinessRecord {
  readonly _tag = "MalformedReadinessRecord"
  readonly error: PersistedRecordError
  readonly row: unknown

  constructor(error: PersistedRecordError, row: unknown) {
    this.error = error
    this.row = row
  }
}

/** Attach an ephemeral raw row to a bounded readiness decode failure for quarantine after commit. */
export const captureMalformedReadinessRow =
  (row: unknown) => <Success, Failure, Requirements>(effect: Effect.Effect<Success, Failure, Requirements>) =>
    Effect.catchIf(
      effect,
      (failure): failure is Failure & PersistedRecordError => Predicate.isTagged("PersistedRecordError")(failure),
      (error) => Effect.fail(new MalformedReadinessRecord(error, row))
    )

const isReadinessHeadRecordKind = (
  recordKind: string
): recordKind is Extract<ReadinessQuarantineRecordKind, "readiness-environment-head" | "readiness-release-head"> => {
  switch (recordKind) {
    case "readiness-environment-head":
    case "readiness-release-head":
      return true
    default:
      return false
  }
}

/** Translate readiness decode failures into the fixed metadata accepted by quarantine storage. */
export const readinessQuarantineDiagnostic = (error: PersistedRecordError): ReadinessQuarantineDiagnostic | null => {
  switch (error.diagnosticCode) {
    case "readiness-rule-schema-invalid":
      return {
        recordKind: "readiness-rule",
        diagnosticCode: "readiness-rule-schema-invalid",
        diagnosticSummary: "Stored readiness rule failed schema validation."
      }
    case "readiness-rule-digest-mismatch":
      return {
        recordKind: "readiness-rule",
        diagnosticCode: "readiness-rule-digest-mismatch",
        diagnosticSummary: "Stored readiness rule digest does not match its canonical material."
      }
    case "readiness-rule-identity-mismatch":
      return {
        recordKind: "readiness-rule",
        diagnosticCode: "readiness-rule-identity-mismatch",
        diagnosticSummary: "Stored readiness rule identity does not match its repository key."
      }
    case "readiness-assessment-schema-invalid":
      return {
        recordKind: "readiness-assessment",
        diagnosticCode: "readiness-assessment-schema-invalid",
        diagnosticSummary: "Stored readiness assessment failed schema validation."
      }
    case "readiness-assessment-digest-mismatch":
      return {
        recordKind: "readiness-assessment",
        diagnosticCode: "readiness-assessment-digest-mismatch",
        diagnosticSummary: "Stored readiness assessment digest does not match its content."
      }
    case "readiness-candidate-digest-mismatch":
      return {
        recordKind: "readiness-assessment",
        diagnosticCode: "readiness-candidate-digest-mismatch",
        diagnosticSummary: "Stored readiness candidate digest does not match its canonical material."
      }
    case "readiness-assessment-identity-mismatch":
      return {
        recordKind: "readiness-assessment",
        diagnosticCode: "readiness-assessment-identity-mismatch",
        diagnosticSummary: "Stored readiness assessment identity does not match its repository key."
      }
    case "readiness-assessment-materialization-mismatch":
      return {
        recordKind: "readiness-assessment",
        diagnosticCode: "readiness-assessment-materialization-mismatch",
        diagnosticSummary: "Stored readiness assessment materialization does not match its canonical content."
      }
    case "readiness-environment-head-schema-invalid":
      return {
        recordKind: "readiness-environment-head",
        diagnosticCode: "readiness-environment-head-schema-invalid",
        diagnosticSummary: "Stored environment readiness head failed schema validation."
      }
    case "readiness-release-head-schema-invalid":
      return {
        recordKind: "readiness-release-head",
        diagnosticCode: "readiness-release-head-schema-invalid",
        diagnosticSummary: "Stored release readiness head failed schema validation."
      }
    case "readiness-head-assessment-mismatch":
      return isReadinessHeadRecordKind(error.recordKind)
        ? {
          recordKind: error.recordKind,
          diagnosticCode: "readiness-head-assessment-mismatch",
          diagnosticSummary: "Stored readiness head does not match its referenced assessment."
        }
        : null
    default:
      return null
  }
}
