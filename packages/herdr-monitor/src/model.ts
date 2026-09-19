import { Schema } from "effect"

const text = (maximum: number) =>
  Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(maximum),
    Schema.makeFilter(
      (value) => [...value].every((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127),
      { expected: "text without control characters" }
    )
  )
export const BoardId = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,47}$/))
const integer = Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }))
const duration = Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 0, maximum: 31536000 }))

/** Explicit publisher assertions only. Null means unavailable; elapsed time is never logged time. */
export const AgentStatus = Schema.Struct({
  id: BoardId,
  name: text(80),
  task: Schema.NullOr(text(160)),
  state: Schema.Literals(["working", "blocked", "idle", "done", "unknown"]),
  status: text(280),
  blocker: Schema.NullOr(text(280)),
  jiraKey: Schema.NullOr(Schema.String.check(Schema.isPattern(/^[A-Z][A-Z0-9]{0,19}-[1-9][0-9]{0,9}$/))),
  branch: Schema.NullOr(text(160)),
  pullRequest: Schema.NullOr(text(120)),
  clockify: Schema.NullOr(
    Schema.Struct({ source: Schema.Literal("clockify"), seconds: duration, observedAt: integer })
  ),
  elapsedSeconds: Schema.NullOr(duration)
})
export interface AgentStatus extends Schema.Schema.Type<typeof AgentStatus> {}

/** Versioned allowlist; no URLs, transcripts, commands, provider locators or credentials. */
export const Snapshot = Schema.Struct({
  version: Schema.Literal(1),
  boardId: BoardId,
  sequence: integer,
  sourceAt: integer,
  title: text(100),
  agents: Schema.Array(AgentStatus).check(Schema.isMaxLength(64))
}).check(
  Schema.makeFilter((snapshot) => new Set(snapshot.agents.map((agent) => agent.id)).size === snapshot.agents.length, {
    expected: "unique agent identifiers"
  })
)
export interface Snapshot extends Schema.Schema.Type<typeof Snapshot> {}

export const BoardView = Schema.Struct({
  receivedAt: integer,
  serverAt: integer,
  stale: Schema.Boolean,
  snapshot: Snapshot
})
export interface BoardView extends Schema.Schema.Type<typeof BoardView> {}

export const MAX_BYTES = 65536
export const STALE_MS = 60000
export const RETENTION_MS = 900000
export const decodeSnapshot = Schema.decodeUnknownEffect(Snapshot, { onExcessProperty: "error" })
