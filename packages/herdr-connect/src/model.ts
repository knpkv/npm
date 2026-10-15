import { AgentStableId, AgentTaskKind, AgentWorkerIdentity, AgentWorkerRelationship } from "@knpkv/herdr-fleet/model"
import { Schema } from "effect"
import { ConnectLastWords } from "./posts.js"
import { ConnectSelfState } from "./self-model.js"
import { terminalColumnBounds, terminalRowBounds } from "./terminal-dimensions.js"

export * from "./self-model.js"

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

export const ConnectAgentRelationship = Schema.Struct({
  ...AgentWorkerRelationship.fields,
  /** Display-only remembered name. It does not assert that the parent is still listed. */
  parentName: Schema.optionalKey(AgentWorkerIdentity.fields.name)
})
export type ConnectAgentRelationship = typeof ConnectAgentRelationship.Type

/** Agent-only palettes in design order; the Relay mark's plum is deliberately excluded. */
export const ConnectAgentHue = Schema.Literals(["rose", "ember", "amber", "lime", "moss", "teal", "sky", "iris"])
export type ConnectAgentHue = typeof ConnectAgentHue.Type

export const ConnectAgent = Schema.Struct({
  id: AgentStableId,
  host: AgentWorkerIdentity.fields.host,
  name: AgentWorkerIdentity.fields.name,
  kind: BoundedString,
  state: BoundedString,
  taskKind: Schema.optionalKey(AgentTaskKind),
  work: AgentWorkLabel,
  lastActivityAt: ActivityTimestamp,
  hue: Schema.optionalKey(ConnectAgentHue),
  voice: Schema.optionalKey(ConnectLastWords),
  self: Schema.optionalKey(Schema.NullOr(ConnectSelfState)),
  relationship: Schema.optionalKey(ConnectAgentRelationship)
})
export type ConnectAgent = typeof ConnectAgent.Type

export const LocalConnectAgents = Schema.Struct({
  host: BoundedString,
  agents: Schema.Array(ConnectAgent).check(Schema.isMaxLength(256)),
  // Only full, error-free inventory producers assert this. Older peers supply no closure evidence.
  complete: Schema.optionalKey(Schema.Boolean)
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
  failures: Schema.Array(ConnectPeerFailure).check(Schema.isMaxLength(256)),
  /** Configured machine names, independent of which machines report usage or live agents. */
  hosts: Schema.optionalKey(Schema.Array(ConnectAgent.fields.host).check(Schema.isMaxLength(256)))
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
  hosts: FleetConnectAgents.fields.hosts,
  nextCursor: Schema.NullOr(ConnectAgentCursor)
})
export type FleetConnectAgentPage = typeof FleetConnectAgentPage.Type

/** Compact closed-agent record. Usage totals and transcripts are never persisted here. */
export const ArchivedConnectAgent = Schema.Struct({
  host: ConnectAgent.fields.host,
  agentId: ConnectAgent.fields.id,
  name: ConnectAgent.fields.name,
  kind: ConnectAgent.fields.kind,
  work: ConnectAgent.fields.work,
  state: ConnectAgent.fields.state,
  hue: ConnectAgent.fields.hue,
  firstSeenAt: ActivityTimestamp,
  closedAt: ActivityTimestamp,
  lastWords: Schema.optionalKey(ConnectLastWords),
  relationship: Schema.optionalKey(ConnectAgentRelationship)
}).check(Schema.makeFilter(
  (agent) => agent.closedAt >= agent.firstSeenAt,
  { expected: "closure at or after first observation" }
))
export type ArchivedConnectAgent = typeof ArchivedConnectAgent.Type

export const ConnectArchiveCursor = Schema.Struct({
  closedAt: ActivityTimestamp,
  host: ConnectAgent.fields.host,
  agentId: ConnectAgent.fields.id
})
export type ConnectArchiveCursor = typeof ConnectArchiveCursor.Type

/** Closed-directory pages include closures at or after this many days before the server clock. */
export const connectArchiveWindowDays = 90
export const connectArchivePageMaxRecords = 64
export const ConnectArchivePage = Schema.Struct({
  agents: Schema.Array(ArchivedConnectAgent).check(Schema.isMaxLength(connectArchivePageMaxRecords)),
  nextCursor: Schema.NullOr(ConnectArchiveCursor)
})
export type ConnectArchivePage = typeof ConnectArchivePage.Type

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
  scrollState: Schema.optionalKey(Schema.Boolean),
  /** Explicit user intent to replace this agent's current controller; absent is an ordinary attach. */
  takeover: Schema.optionalKey(Schema.Boolean)
})
export type TerminalSelection = typeof TerminalSelection.Type

/** A fresh authenticated host reading, required before a hub forwards takeover intent. */
export const TerminalCapabilities = Schema.Struct({ takeover: Schema.Literal(true) })
export type TerminalCapabilities = typeof TerminalCapabilities.Type

/** Close-event identity for a superseded controller, including through a relaying hub. */
export const TerminalTakenOverClose = Schema.Struct({
  code: Schema.Literal(4_424),
  reason: Schema.Literal("taken_over")
})
export type TerminalTakenOverClose = typeof TerminalTakenOverClose.Type

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
  // Taken only while scrolling was quiet, so it includes every scroll the session forwarded.
  offsetFromBottom: Schema.NullOr(Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))),
  // How many `terminal.scroll` commands this session had forwarded when the read started. The
  // client uses the reading only if it equals the scrolls it sent, so none was in flight.
  scrollsForwarded: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))
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

export { agentStateBucket, type ConnectAgentGroup, connectAgentGroup } from "./agent-state-core.js"
