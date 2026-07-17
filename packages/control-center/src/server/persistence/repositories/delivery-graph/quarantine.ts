import * as Effect from "effect/Effect"
import * as Predicate from "effect/Predicate"

import type { PersistedRecordError } from "../../errors.js"
import type { QuarantineDiagnosticSummary, QuarantineReasonCode, QuarantineRecordKind } from "../models.js"

type DeliveryGraphQuarantineRecordKind = Extract<
  QuarantineRecordKind,
  | "delivery-node"
  | "delivery-relationship"
  | "entity-projection"
  | "evidence-claim"
  | "evidence-freshness"
  | "evidence-item"
  | "person"
  | "person-avatar"
>

interface DeliveryGraphQuarantineDiagnostic {
  readonly diagnosticCode: QuarantineReasonCode
  readonly diagnosticSummary: QuarantineDiagnosticSummary
  readonly recordKind: DeliveryGraphQuarantineRecordKind
}

/** Internal carrier that keeps malformed values out of the public error channel. */
export class MalformedDeliveryGraphRecord {
  readonly _tag = "MalformedDeliveryGraphRecord"
  readonly error: PersistedRecordError
  readonly row: unknown

  constructor(error: PersistedRecordError, row: unknown) {
    this.error = error
    this.row = row
  }
}

/** Attach an ephemeral raw row to a bounded graph decode failure for later redacted quarantine. */
export const captureMalformedDeliveryGraphRow = (row: unknown) =>
<Success, Failure, Requirements>(
  effect: Effect.Effect<Success, Failure, Requirements>
) =>
  Effect.catchIf(
    effect,
    (failure): failure is Failure & PersistedRecordError => Predicate.isTagged("PersistedRecordError")(failure),
    (error) => Effect.fail(new MalformedDeliveryGraphRecord(error, row))
  )

const isDeliveryGraphRecordKind = (recordKind: string): recordKind is DeliveryGraphQuarantineRecordKind => {
  switch (recordKind) {
    case "delivery-node":
    case "delivery-relationship":
    case "entity-projection":
    case "evidence-claim":
    case "evidence-freshness":
    case "evidence-item":
      return true
    default:
      return false
  }
}

/** Translate graph decoder failures into the fixed metadata accepted by quarantine storage. */
export const deliveryGraphQuarantineDiagnostic = (
  error: PersistedRecordError
): DeliveryGraphQuarantineDiagnostic | null => {
  switch (error.diagnosticCode) {
    case "delivery-graph-digest-mismatch":
      return isDeliveryGraphRecordKind(error.recordKind)
        ? {
          recordKind: error.recordKind,
          diagnosticCode: "delivery-graph-digest-mismatch",
          diagnosticSummary: "Stored delivery graph record digest does not match its content."
        }
        : null
    case "delivery-node-schema-invalid":
      return {
        recordKind: "delivery-node",
        diagnosticCode: "delivery-node-schema-invalid",
        diagnosticSummary: "Stored delivery node failed schema validation."
      }
    case "delivery-relationship-schema-invalid":
      return {
        recordKind: "delivery-relationship",
        diagnosticCode: "delivery-relationship-schema-invalid",
        diagnosticSummary: "Stored delivery relationship failed schema validation."
      }
    case "entity-projection-schema-invalid":
      return {
        recordKind: "entity-projection",
        diagnosticCode: "entity-projection-schema-invalid",
        diagnosticSummary: "Stored entity projection failed schema validation."
      }
    case "evidence-claim-schema-invalid":
      return {
        recordKind: "evidence-claim",
        diagnosticCode: "evidence-claim-schema-invalid",
        diagnosticSummary: "Stored evidence claim failed schema validation."
      }
    case "evidence-freshness-schema-invalid":
      return {
        recordKind: "evidence-freshness",
        diagnosticCode: "evidence-freshness-schema-invalid",
        diagnosticSummary: "Stored evidence freshness failed schema validation."
      }
    case "evidence-item-schema-invalid":
      return {
        recordKind: "evidence-item",
        diagnosticCode: "evidence-item-schema-invalid",
        diagnosticSummary: "Stored evidence item failed schema validation."
      }
    case "person-schema-invalid":
      return error.recordKind === "person"
        ? {
          recordKind: "person",
          diagnosticCode: "person-schema-invalid",
          diagnosticSummary: "Stored person record failed schema validation."
        }
        : null
    case "schema-decode-failed":
      return error.recordKind === "person-avatar"
        ? {
          recordKind: "person-avatar",
          diagnosticCode: "schema-decode-failed",
          diagnosticSummary: "Stored person avatar failed schema validation."
        }
        : null
    default:
      return null
  }
}
