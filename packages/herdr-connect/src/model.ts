import { AgentStableId, AgentWorkerIdentity, AgentWorkerRelationship } from "@knpkv/herdr-fleet/model"
import { Schema } from "effect"

const BoundedString = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(256)
)
export const AgentWorkLabel = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(256),
  Schema.isPattern(/^[^/\\\p{Cc}]+$/u)
)
const ActivityTimestamp = Schema.Number.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 0, maximum: 8_640_000_000_000_000 })
)

export const ConnectAgentRelation = Schema.Literals([
  "delegated",
  "pair",
  "review"
])
export type ConnectAgentRelation = typeof ConnectAgentRelation.Type

export const ConnectAgentRelationship = AgentWorkerRelationship
export type ConnectAgentRelationship = typeof ConnectAgentRelationship.Type

export const ConnectAgent = Schema.Struct({
  id: AgentStableId,
  host: AgentWorkerIdentity.fields.host,
  name: AgentWorkerIdentity.fields.name,
  kind: BoundedString,
  state: BoundedString,
  work: AgentWorkLabel,
  lastActivityAt: ActivityTimestamp,
  relationship: Schema.optionalKey(ConnectAgentRelationship)
})
export type ConnectAgent = typeof ConnectAgent.Type

export const LocalConnectAgents = Schema.Struct({
  host: BoundedString,
  agents: Schema.Array(ConnectAgent).check(Schema.isMaxLength(256))
})
export type LocalConnectAgents = typeof LocalConnectAgents.Type

export const ConnectPeerFailure = Schema.Struct({
  host: BoundedString,
  reason: Schema.Literals([
    "offline",
    "unavailable",
    "timeout",
    "request_failed",
    "invalid_response"
  ])
})
export type ConnectPeerFailure = typeof ConnectPeerFailure.Type

export const FleetConnectAgents = Schema.Struct({
  agents: Schema.Array(ConnectAgent).check(Schema.isMaxLength(1_024)),
  failures: Schema.Array(ConnectPeerFailure).check(Schema.isMaxLength(256))
})
export type FleetConnectAgents = typeof FleetConnectAgents.Type

const TerminalColumns = Schema.Number.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 20, maximum: 400 })
)
const TerminalRows = Schema.Number.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 5, maximum: 200 })
)
const TerminalScrollLines = Schema.Number.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 1, maximum: 400 })
)

export const terminalCommandMaxPayloadBytes = 512 * 1024

export const TerminalSelection = Schema.Struct({
  host: BoundedString,
  agentId: BoundedString,
  cols: TerminalColumns,
  rows: TerminalRows
})
export type TerminalSelection = typeof TerminalSelection.Type

export const TerminalClientCommand = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("terminal.input"),
    text: Schema.String.check(Schema.isMaxLength(65_536))
  }),
  Schema.Struct({
    type: Schema.Literal("terminal.resize"),
    cols: TerminalColumns,
    rows: TerminalRows,
    cell_width_px: Schema.Number.check(
      Schema.isInt(),
      Schema.isBetween({ minimum: 0, maximum: 1_024 })
    ),
    cell_height_px: Schema.Number.check(
      Schema.isInt(),
      Schema.isBetween({ minimum: 0, maximum: 1_024 })
    )
  }),
  Schema.Struct({ type: Schema.Literal("terminal.release") }),
  Schema.Struct({
    type: Schema.Literal("terminal.scroll"),
    direction: Schema.Literals(["up", "down"]),
    lines: TerminalScrollLines,
    source: Schema.Literals(["wheel", "page_key"]),
    modifiers: Schema.Number.check(
      Schema.isInt(),
      Schema.isBetween({ minimum: 0, maximum: 15 })
    )
  })
])
export type TerminalClientCommand = typeof TerminalClientCommand.Type

export const terminalFrameMaxEncodedBytes = 4 * 1024 * 1024

export const HerdrTerminalEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("terminal.frame"),
    seq: Schema.Number,
    encoding: Schema.Literal("ansi"),
    width: Schema.Number,
    height: Schema.Number,
    full: Schema.Boolean,
    bytes: Schema.String.check(
      Schema.isMaxLength(terminalFrameMaxEncodedBytes),
      Schema.isPattern(
        /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/
      )
    )
  }),
  Schema.Struct({
    type: Schema.Literal("terminal.closed"),
    reason: Schema.String.check(Schema.isMaxLength(1_024))
  })
])
export type HerdrTerminalEvent = typeof HerdrTerminalEvent.Type

export const TerminalServerSignal = Schema.Union([
  Schema.Struct({ type: Schema.Literal("terminal.ready") }),
  Schema.Struct({
    type: Schema.Literal("terminal.closed"),
    reason: Schema.String.check(Schema.isMaxLength(1_024))
  })
])
export type TerminalServerSignal = typeof TerminalServerSignal.Type
