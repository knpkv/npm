import { AgentStableId, AgentWorkerIdentity, AgentWorkerRelationship } from "@knpkv/herdr-fleet/model"
import { Schema } from "effect"
import { terminalColumnBounds, terminalRowBounds } from "./terminal-dimensions.js"

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

export const connectAgentPageMaxRecords = 64
export const ConnectAgentCursor = Schema.Struct({
  host: ConnectAgent.fields.host,
  id: ConnectAgent.fields.id
})
export type ConnectAgentCursor = typeof ConnectAgentCursor.Type

export const FleetConnectAgentPage = Schema.Struct({
  agents: Schema.Array(ConnectAgent).check(
    Schema.isMaxLength(connectAgentPageMaxRecords)
  ),
  failures: FleetConnectAgents.fields.failures,
  nextCursor: Schema.NullOr(ConnectAgentCursor)
})
export type FleetConnectAgentPage = typeof FleetConnectAgentPage.Type

const TerminalColumns = Schema.Number.check(
  Schema.isInt(),
  Schema.isBetween(terminalColumnBounds)
)
const TerminalRows = Schema.Number.check(
  Schema.isInt(),
  Schema.isBetween(terminalRowBounds)
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
  rows: TerminalRows,
  // The client understands `terminal.scroll_state`. Absent for older clients, which would close
  // the terminal on an unknown signal, so hosts send scroll states only when it is set.
  scrollState: Schema.optionalKey(Schema.Boolean)
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

/**
 * How far herdr has the pane scrolled back, read from `herdr pane get`. herdr keeps that position
 * while output arrives and between viewers, so only the server can know it. `null` means the read
 * failed and the position is unknown — never "at the bottom".
 */
export const TerminalScrollState = Schema.Struct({
  type: Schema.Literal("terminal.scroll_state"),
  offsetFromBottom: Schema.NullOr(Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))),
  // How many `terminal.scroll` commands the connector had forwarded when it took the reading, so
  // the client can re-apply the ones the reading does not cover yet.
  scrollCommands: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))
})
export type TerminalScrollState = typeof TerminalScrollState.Type

/** What a terminal session yields: herdr's own events plus the scroll state the connector reads. */
export type TerminalSessionEvent = HerdrTerminalEvent | TerminalScrollState

export const TerminalServerSignal = Schema.Union([
  Schema.Struct({ type: Schema.Literal("terminal.ready") }),
  Schema.Struct({
    type: Schema.Literal("terminal.closed"),
    reason: Schema.String.check(Schema.isMaxLength(1_024))
  }),
  TerminalScrollState
])
export type TerminalServerSignal = typeof TerminalServerSignal.Type
