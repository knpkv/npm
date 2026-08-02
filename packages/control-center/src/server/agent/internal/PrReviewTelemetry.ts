/** Metadata-only telemetry for local pull-request review execution. @module */
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

import { JobId, WorkspaceId } from "../../../domain/identifiers.js"
import { AgentAttemptSequence } from "../../persistence/repositories/agentJobModels.js"

const BoundedName = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(200)
)

/** One exported review execution observation; content-bearing values are absent by construction. */
export const PrReviewTelemetryRecord = Schema.Struct({
  workspaceId: WorkspaceId,
  jobId: JobId,
  attemptSequence: AgentAttemptSequence,
  revision: BoundedName,
  provider: BoundedName,
  model: Schema.NullOr(BoundedName),
  cli: BoundedName,
  phase: BoundedName,
  commandName: BoundedName,
  durationMillis: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  exitStatus: Schema.NullOr(Schema.Int),
  stdoutBytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  stderrBytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  suggestionCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  noteCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  errorType: Schema.NullOr(BoundedName)
}).annotate({ identifier: "PrReviewTelemetryRecord" })

/** Decoded metadata-only review telemetry. */
export type PrReviewTelemetryRecord = typeof PrReviewTelemetryRecord.Type

/** Emit one review observation through the configured OpenTelemetry logger. */
export const emitPrReviewTelemetry = (record: PrReviewTelemetryRecord) => Effect.logInfo("pr-review.telemetry", record)
