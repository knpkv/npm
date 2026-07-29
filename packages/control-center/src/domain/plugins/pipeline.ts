import * as Encoding from "effect/Encoding"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"

import { Revision } from "../sourceRevision.js"
import { UtcTimestamp } from "../utcTimestamp.js"
import { PluginEntityReferenceV1 } from "./events.js"

const boundedOpaque = (name: string, maximum: number) =>
  Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(maximum)).pipe(Schema.brand(name))

const NonNegativeInteger = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const PositiveInteger = Schema.Int.check(Schema.isGreaterThan(0))
const MaximumArtifactRangeBytes = 1024 * 1024
const MaximumArtifactRangeBase64Characters = 4 * Math.ceil(MaximumArtifactRangeBytes / 3)
const MaximumLogPageBytes = 1024 * 1024
const utf8Encoder = new TextEncoder()
const Utf8BoundedLogMessage = Schema.String.check(
  Schema.makeFilter(
    (message) => utf8Encoder.encode(message).byteLength <= MaximumLogPageBytes,
    { expected: `at most ${MaximumLogPageBytes} UTF-8 log message bytes` }
  )
)

/** Exact provider action selected for a bounded pipeline evidence read. */
export const PluginPipelineActionReferenceV1 = Schema.Struct({
  entity: PluginEntityReferenceV1,
  executionId: boundedOpaque("PluginPipelineExecutionId", 256),
  actionExecutionId: boundedOpaque("PluginPipelineActionExecutionId", 256),
  expectedRevision: Revision
})

/** Decoded exact pipeline action identity. */
export type PluginPipelineActionReferenceV1 = typeof PluginPipelineActionReferenceV1.Type

/** Bounded request for one page of pipeline action log events. */
export const PluginPipelineLogPageRequestV1 = Schema.Struct({
  action: PluginPipelineActionReferenceV1,
  cursor: Schema.NullOr(boundedOpaque("PluginPipelineLogCursor", 4_096)),
  limit: PositiveInteger.check(Schema.isLessThanOrEqualTo(100))
})

/** One browser-safe provider log event. */
export const PluginPipelineLogEventV1 = Schema.Struct({
  timestamp: UtcTimestamp,
  ingestionTimestamp: Schema.NullOr(UtcTimestamp),
  message: Utf8BoundedLogMessage
})

/** Bounded pipeline action log page with an opaque continuation cursor. */
export const PluginPipelineLogPageV1 = Schema.Struct({
  events: Schema.Array(PluginPipelineLogEventV1).check(
    Schema.makeFilter((events) => events.length <= 100, { expected: "at most 100 pipeline log events" }),
    Schema.makeFilter(
      (events) =>
        events.reduce((total, event) => total + utf8Encoder.encode(event.message).byteLength, 0) <=
          MaximumLogPageBytes,
      { expected: `at most ${MaximumLogPageBytes} UTF-8 log message bytes` }
    )
  ),
  nextCursor: Schema.NullOr(boundedOpaque("PluginPipelineLogCursor", 4_096))
})

/** Bounded request for one action artifact byte range. */
export const PluginPipelineArtifactRangeRequestV1 = Schema.Struct({
  action: PluginPipelineActionReferenceV1,
  direction: Schema.Literals(["input", "output"]),
  artifactName: boundedOpaque("PluginPipelineArtifactName", 256),
  offset: NonNegativeInteger,
  length: PositiveInteger.check(Schema.isLessThanOrEqualTo(MaximumArtifactRangeBytes))
})

/** Browser-safe artifact bytes; provider storage coordinates are deliberately absent. */
export const PluginPipelineArtifactRangeV1 = Schema.Struct({
  bytesBase64: Schema.String.check(
    Schema.isMaxLength(MaximumArtifactRangeBase64Characters),
    Schema.isBase64(),
    Schema.makeFilter((value) => {
      const decoded = Encoding.decodeBase64(value)
      return Result.isSuccess(decoded) && decoded.success.byteLength <= MaximumArtifactRangeBytes
    }, { expected: `at most ${MaximumArtifactRangeBytes} base64-decoded bytes` })
  ),
  totalBytes: NonNegativeInteger,
  contentType: Schema.Literal("application/octet-stream"),
  filename: Schema.String.check(
    Schema.isTrimmed(),
    Schema.isNonEmpty(),
    Schema.isMaxLength(255),
    Schema.isPattern(/^[^"\\/\r\n]+$/u, { expected: "a safe attachment filename" })
  )
})

export type PluginPipelineLogPageRequestV1 = typeof PluginPipelineLogPageRequestV1.Type
export type PluginPipelineLogPageV1 = typeof PluginPipelineLogPageV1.Type
export type PluginPipelineArtifactRangeRequestV1 = typeof PluginPipelineArtifactRangeRequestV1.Type
export type PluginPipelineArtifactRangeV1 = typeof PluginPipelineArtifactRangeV1.Type
