import { ConnectAgent, connectAgentGroup } from "@knpkv/herdr-connect/model"
import { Schema } from "effect"

/** The notification bucket for known Herdr states; unavailable or new states preserve episode evidence. */
export const blockedAgentBucket = (state: string): "blocked" | "needs-you" | "inactive" | "unknown" => {
  const bucket = connectAgentGroup(state, { presentation: "push" })
  return bucket === "unknown" ? "unknown" : bucket === "needs-you"
    ? state.toLocaleLowerCase("en-US") === "blocked" ? "blocked" : "needs-you"
    : "inactive"
}

const Label = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256))
const Timestamp = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 8_640_000_000_000_000 }))
export const BlockedAgent = Schema.Struct({
  ...ConnectAgent.fields,
  firstLine: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(1024))),
  blocker: Schema.optionalKey(Schema.Boolean),
  approvalJobId: Schema.optionalKey(Label),
  eventId: Schema.optionalKey(Label)
})
export const BlockedObservation = Schema.Struct({
  host: ConnectAgent.fields.host,
  agents: Schema.Array(BlockedAgent).check(Schema.isMaxLength(256)),
  observedAt: Timestamp,
  complete: Schema.Boolean
}).check(Schema.makeFilter(
  (value) => value.agents.every((agent) => agent.host.toLowerCase() === value.host.toLowerCase()),
  { expected: "agents belonging to the observed host" }
))
export type BlockedObservation = typeof BlockedObservation.Type

/** Only a bounded Voice blocker first line or the generated name/state sentence enters a notification. */
export const BlockedPushPayload = Schema.Struct({
  kind: Schema.Literal("agent-blocked"),
  host: ConnectAgent.fields.host,
  agentId: ConnectAgent.fields.id,
  agentName: ConnectAgent.fields.name,
  state: Schema.Literals(["blocked", "needs-you"]),
  firstLine: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(240), Schema.isPattern(/^[^\p{Cc}]+$/u)),
  approvalJobId: Schema.NullOr(Label),
  eventId: Schema.optionalKey(Label)
})
export type BlockedPushPayload = typeof BlockedPushPayload.Type

export const PushAgentKey = Schema.Struct({ host: ConnectAgent.fields.host, agentId: ConnectAgent.fields.id })
const Minute = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1439 }))
const TimeZone = Schema.String.check(
  Schema.isPattern(/^[A-Za-z][A-Za-z0-9_+\-/]{0,63}$/u),
  Schema.makeFilter((timeZone) => {
    try {
      new Intl.DateTimeFormat("en", { timeZone }).format(0)
      return true
    } catch {
      return false
    }
  }, { expected: "an IANA time zone supported by Intl.DateTimeFormat" })
)
/** Quiet hours use the selected IANA zone, with an inclusive start and exclusive end; equal endpoints mean all day. */
export const BlockedPushSettings = Schema.Struct({
  mutedAgents: Schema.Array(PushAgentKey).check(Schema.isMaxLength(256)),
  quietHours: Schema.NullOr(Schema.Struct({ startMinute: Minute, endMinute: Minute, timeZone: TimeZone }))
})
export type BlockedPushSettings = typeof BlockedPushSettings.Type
export const StageHeartbeat = Schema.Struct({
  clientId: Label,
  target: Schema.NullOr(PushAgentKey)
})
export type StageHeartbeat = typeof StageHeartbeat.Type

export const blockedPushReminderMillis = 15 * 60 * 1_000
export const stageViewingTtlMillis = 45_000

export class BlockedPushStoreError extends Schema.TaggedError<BlockedPushStoreError>()("BlockedPushStoreError", {
  operation: Schema.String,
  cause: Schema.Defect()
}) {}
export class BlockedPushRecipientError
  extends Schema.TaggedError<BlockedPushRecipientError>()("BlockedPushRecipientError", {
    cause: Schema.Defect()
  })
{}

export const blockedPromptFirstLine = (text: string): string =>
  (text.split(/\r\n|[\n\r\u2028\u2029]/u)[0] ?? "").replace(/\p{Cc}/gu, "").trim().slice(0, 240) ||
  "Needs your attention"
