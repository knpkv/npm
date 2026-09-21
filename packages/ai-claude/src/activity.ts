import { Effect, Schema, Stream } from "effect"
import { ClaudeFailureCause, invalidOutput, transportFailure } from "./errors.js"

/** Caller-supplied request, visible output, final response or a milestone. Excludes system events and reasoning. */
export interface ClaudeActivity {
  readonly kind: "status" | "text" | "request" | "response"
  readonly text: string
}

const Event = Schema.Struct({
  type: Schema.String,
  event: Schema.optional(Schema.Struct({
    type: Schema.String,
    index: Schema.optional(Schema.Number),
    content_block: Schema.optional(Schema.Struct({ type: Schema.String, name: Schema.optional(Schema.String) })),
    delta: Schema.optional(Schema.Struct({
      type: Schema.optional(Schema.String),
      text: Schema.optional(Schema.String),
      partial_json: Schema.optional(Schema.String)
    }))
  }))
})
const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(Event))

/** Consume bounded NDJSON as it arrives; only the authoritative result is retained for final decoding. */
export const collectActivity = Effect.fn("ClaudeCli.collectActivity")(function*(
  source: Stream.Stream<Uint8Array, unknown>,
  maximumBytes: number,
  method: string,
  report: (activity: ClaudeActivity) => Effect.Effect<void>
) {
  let bytes = 0
  let result = ""
  const structuredBlocks = new Set<number>()
  yield* source.pipe(
    Stream.mapError((cause) => transportFailure("process", "Failed reading Claude CLI stdout", cause)),
    Stream.mapEffect((chunk) => {
      bytes += chunk.byteLength
      return bytes > maximumBytes
        ? Effect.fail(
          transportFailure(
            "process",
            `Claude CLI stdout exceeded ${maximumBytes} bytes for ${method}`,
            new ClaudeFailureCause({ reason: "stdout-limit-exceeded" })
          )
        )
        : Effect.succeed(chunk)
    }),
    Stream.decodeText(),
    Stream.splitLines,
    Stream.filter((line) => line.trim().length > 0),
    Stream.runForEach((line) =>
      Effect.gen(function*() {
        const envelope = yield* decode(line).pipe(
          Effect.mapError(() => invalidOutput("Claude CLI emitted malformed stream JSON", method))
        )
        if (envelope.type === "result") {
          result = line
          return
        }
        if (envelope.type !== "stream_event" || envelope.event === undefined) return
        const event = envelope.event
        if (event.type === "message_start") {
          structuredBlocks.clear()
          yield* report({ kind: "status", text: "Agent responding" })
        }
        if (
          event.type === "content_block_start" && event.index !== undefined &&
          event.content_block?.name === "StructuredOutput"
        ) {
          structuredBlocks.add(event.index)
          yield* report({ kind: "status", text: "Writing structured answer" })
        }
        if (event.type !== "content_block_delta") return
        const delta = event.delta
        const text = delta?.type === "text_delta"
          ? delta.text
          : delta?.type === "input_json_delta" && event.index !== undefined && structuredBlocks.has(event.index)
          ? delta.partial_json
          : undefined
        if (text !== undefined && text.length > 0) yield* report({ kind: "text", text })
      })
    )
  )
  if (result.length === 0) return yield* invalidOutput("Claude CLI emitted no result event", method)
  return result
})
