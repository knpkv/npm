import { Effect, Schema } from "effect"
import { invalidOutput } from "./errors.js"

const TokenCount = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

const ClaudeUsage = Schema.Struct({
  input_tokens: Schema.optional(TokenCount),
  output_tokens: Schema.optional(TokenCount),
  cache_creation_input_tokens: Schema.optional(TokenCount),
  cache_read_input_tokens: Schema.optional(TokenCount)
})

const ClaudeResult = Schema.Struct({
  type: Schema.Literal("result"),
  subtype: Schema.String,
  is_error: Schema.Boolean,
  result: Schema.optional(Schema.String),
  structured_output: Schema.optional(Schema.Unknown),
  usage: Schema.optional(ClaudeUsage)
})

export type ClaudeResult = typeof ClaudeResult.Type

const decodeResult = Schema.decodeUnknownEffect(Schema.fromJsonString(ClaudeResult))

export const decodeClaudeOutput = (
  stdout: string,
  method: string
): Effect.Effect<ClaudeResult, ReturnType<typeof invalidOutput>> =>
  decodeResult(stdout.trim()).pipe(
    Effect.catch(() => {
      const nonEmptyLines = stdout.split("\n").map((line) => line.trim()).filter((line) => line.length > 0)
      return Effect.forEach(nonEmptyLines, (line) => decodeResult(line)).pipe(
        Effect.flatMap((events) => {
          const result = events.length === 0 ? undefined : events[events.length - 1]
          return result === undefined
            ? Effect.fail(invalidOutput("Claude CLI emitted no result event", method))
            : Effect.succeed(result)
        }),
        Effect.mapError(() => invalidOutput("Claude CLI emitted malformed JSON output", method))
      )
    })
  )
