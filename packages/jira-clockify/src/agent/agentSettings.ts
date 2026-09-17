/** Provider selection shared by config persistence, the session engine and settings controls. */
import * as Schema from "effect/Schema"

const ClaudeEffort = Schema.Literals(["low", "medium", "high", "xhigh", "max"])
const CodexEffort = Schema.Literals(["minimal", "low", "medium", "high", "xhigh"])
const Model = Schema.NullOr(Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(200),
  Schema.isTrimmed()
))

/** Complete stored settings. Null model and effort leave those choices to the selected CLI. */
export const SessionAgentSettings = Schema.Union([
  Schema.Struct({
    provider: Schema.Literal("claude"),
    model: Model,
    effort: Schema.NullOr(ClaudeEffort)
  }),
  Schema.Struct({
    provider: Schema.Literal("codex"),
    model: Model,
    effort: Schema.NullOr(CodexEffort)
  })
])

export type SessionAgentSettings = typeof SessionAgentSettings.Type

/** Existing installations keep Claude with its default model and effort. */
export const defaultSessionAgentSettings: SessionAgentSettings = { provider: "claude", model: null, effort: null }

/** Supported explicit efforts for a provider; controls add their own null/default option. */
export const agentEfforts = (provider: SessionAgentSettings["provider"]) =>
  provider === "claude" ? ClaudeEffort.literals : CodexEffort.literals
