/** CLI, MCP and HTTP decode the same lexical options before validating creature state. */
import { ConnectSelfBody, InvalidReport } from "@knpkv/herdr-connect"
import { Effect, Schema, SchemaIssue } from "effect"

export const RelaySelfOptions = Schema.Struct({
  mood: Schema.optionalKey(Schema.String),
  say: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[^\p{Cc}]*$/u))),
  accessory: Schema.optionalKey(Schema.String)
})
export type RelaySelfOptions = typeof RelaySelfOptions.Type

const normalizeRelaySelfBody = Effect.fn("Relay.normalizeSelfBody")(function*(input: RelaySelfOptions) {
  const normalized = { ...input }
  if (input.say !== undefined) normalized.say = input.say.trim()
  return yield* Schema.decodeUnknownEffect(ConnectSelfBody)(normalized)
})
const invalidSelf = (error: Schema.SchemaError): InvalidReport =>
  new InvalidReport({
    detail: SchemaIssue.makeFormatterStandardSchemaV1()(error.issue).issues
      .map(({ message, path }) => `${path?.map(String).join(".") ?? "self"} ${message}`).join("; ")
  })

/** Boundary parser: rejects extra keys and control characters before trimming or calling application code. */
export const decodeRelaySelfBody = Effect.fn("Relay.decodeSelfBody")(
  Schema.decodeUnknownEffect(RelaySelfOptions, { onExcessProperty: "error" }),
  Effect.flatMap(normalizeRelaySelfBody),
  Effect.mapError(invalidSelf)
)
