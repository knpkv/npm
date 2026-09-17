import { Option, Schema } from "effect"

const decodeJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Union([Schema.Record(Schema.String, Schema.Unknown), Schema.Array(Schema.Unknown)]))
)

/** Indent complete JSON objects and arrays; keep prose and unfinished streaming text unchanged. */
export const formatAgentText = (text: string): string => {
  const decoded = decodeJson(text)
  if (Option.isSome(decoded)) {
    return JSON.stringify(decoded.value, null, 2)
  }
  return text
}
