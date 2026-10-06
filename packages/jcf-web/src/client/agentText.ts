import { Option, Schema } from "effect"

const decodeJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Union([Schema.Record(Schema.String, Schema.Unknown), Schema.Array(Schema.Unknown)]))
)

/** Agent text as shown: indented JSON (set as code) or prose and unfinished streaming text, unchanged. */
export interface AgentText {
  readonly kind: "json" | "prose"
  readonly text: string
}

/** Indent complete JSON objects and arrays; keep prose and unfinished streaming text unchanged. */
export const formatAgentText = (text: string): AgentText => {
  const decoded = decodeJson(text)
  if (Option.isSome(decoded)) {
    return { kind: "json", text: JSON.stringify(decoded.value, null, 2) }
  }
  return { kind: "prose", text }
}
