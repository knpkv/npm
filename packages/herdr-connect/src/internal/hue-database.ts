import { Schema } from "effect"
import type { DatabaseSync } from "node:sqlite"
import { type ConnectAgent, ConnectAgentHue } from "../model.js"

const BodyKind = Schema.Literals(["circle", "squircle", "pear", "star", "bean"])
const bodyKinds = BodyKind.literals
const HueRow = Schema.Struct({
  agent_id: Schema.String,
  hue: ConnectAgentHue,
  body_kind: BodyKind,
  exclusive: Schema.Literals([0, 1]),
  closed_at: Schema.NullOr(Schema.Number),
  observed_at: Schema.Number
})
type HueRow = typeof HueRow.Type

/** Same un-mixed FNV-1a host:name seed as the creature's old-hub palette fallback. */
const hueSeed = (host: string, name: string): number => {
  let hash = 2166136261
  for (const char of `${host}:${name}`) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619)
  return hash >>> 0
}

/** The drawing's independent mixed host:id seed and five-shape field, never derived from its hue. */
const bodyKindFor = (host: string, id: string): typeof BodyKind.Type => {
  let hash = 2166136261
  for (const char of `${host}:${id}`) hash = Math.imul(hash ^ (char.codePointAt(0) ?? 0), 16777619)
  hash ^= hash >>> 16
  hash = Math.imul(hash, 0x85ebca6b)
  hash ^= hash >>> 13
  hash = Math.imul(hash, 0xc2b2ae35)
  const seed = (hash ^ (hash >>> 16)) >>> 0
  return Schema.decodeUnknownSync(BodyKind)(bodyKinds[(seed >>> 3) % bodyKinds.length])
}

/** Activity owns these allocations; archive closure releases the live reservation in its own transaction. */
export const initializeHues = (database: DatabaseSync): void => {
  database.exec(`
    CREATE TABLE IF NOT EXISTS connect_agent_hues (
      host TEXT COLLATE NOCASE NOT NULL, agent_id TEXT NOT NULL,
      hue TEXT NOT NULL CHECK (hue IN ('rose','ember','amber','lime','moss','teal','sky','iris')),
      body_kind TEXT NOT NULL CHECK (body_kind IN ('circle','squircle','pear','star','bean')),
      exclusive INTEGER NOT NULL CHECK (exclusive IN (0,1)), closed_at INTEGER, observed_at INTEGER NOT NULL,
      PRIMARY KEY (host, agent_id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS connect_hue_live_reservation
      ON connect_agent_hues (host, hue) WHERE exclusive = 1 AND closed_at IS NULL;
  `)
}

const chooseHue = (
  host: string,
  agent: ConnectAgent,
  rows: ReadonlyArray<HueRow>,
  bodyKind: typeof BodyKind.Type
): ConnectAgentHue => {
  const families = ConnectAgentHue.literals
  const existing = rows.find(({ agent_id }) => agent_id === agent.id)
  const holders = rows.filter(({ agent_id, closed_at }) => agent_id !== agent.id && closed_at === null)
  const free = families.filter((family) => !holders.some(({ hue }) => hue === family))
  if (existing !== undefined && (existing.closed_at === null || free.includes(existing.hue))) return existing.hue
  // Reuse the oldest archived-only holder, breaking equal closure times by design family order.
  const retired = rows.flatMap(({ closed_at, hue }) =>
    closed_at === null || !free.includes(hue) ? [] : [{ hue, closedAt: closed_at }]
  ).toSorted((a, b) => a.closedAt - b.closedAt || families.indexOf(a.hue) - families.indexOf(b.hue))
  const oldest = retired[0]
  if (oldest !== undefined) return oldest.hue
  const seed = hueSeed(host, agent.name) % families.length
  const hashFamily = Schema.decodeUnknownSync(ConnectAgentHue)(families[seed])
  for (let offset = 0; offset < families.length; offset++) {
    const family = families[(seed + offset) % families.length]
    if (family !== undefined && free.includes(family)) return family
  }
  // Above eight live agents, repeated colours stay distinguishable by the independent body shape.
  return families.find((family) =>
    !holders.some(({ body_kind: heldKind, hue }) => hue === family && heldKind === bodyKind)
  ) ?? hashFamily
}

/** Caller owns BEGIN IMMEDIATE; every choice sees the preceding insertion, including other connections. */
export const assignHues = (
  database: DatabaseSync,
  host: string,
  agents: ReadonlyArray<ConnectAgent>,
  observedAt: number
): ReadonlyArray<ConnectAgent> => {
  const normalized = host.toLowerCase()
  const rows = Schema.decodeUnknownSync(Schema.Array(HueRow))(
    database.prepare(
      "SELECT agent_id, hue, body_kind, exclusive, closed_at, observed_at FROM connect_agent_hues WHERE host = ?"
    ).all(normalized)
  )
  const byId = new Map(rows.map((row) => [row.agent_id, row]))
  const write = database.prepare(`
    INSERT INTO connect_agent_hues (host, agent_id, hue, body_kind, exclusive, closed_at, observed_at) VALUES (?, ?, ?, ?, ?, NULL, ?)
    ON CONFLICT(host, agent_id) DO UPDATE SET hue = excluded.hue, body_kind = excluded.body_kind,
      exclusive = excluded.exclusive, closed_at = NULL, observed_at = excluded.observed_at
  `)
  for (const agent of agents.toSorted((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) {
    const previous = byId.get(agent.id)
    if (
      previous !== undefined && (
        previous.observed_at > observedAt || (previous.closed_at !== null && previous.closed_at >= observedAt)
      )
    ) continue
    const current = [...byId.values()]
    const bodyKind = bodyKindFor(host, agent.id)
    const hue = chooseHue(host, agent, current, bodyKind)
    const exclusive = current.some((row) =>
        row.agent_id !== agent.id && row.closed_at === null && row.hue === hue && row.exclusive === 1
      )
      ? 0
      : 1
    write.run(normalized, agent.id, hue, bodyKind, exclusive, observedAt)
    byId.set(agent.id, {
      agent_id: agent.id,
      hue,
      body_kind: bodyKind,
      exclusive,
      closed_at: null,
      observed_at: observedAt
    })
  }
  return agents.map((agent) => {
    const hue = Schema.decodeUnknownSync(ConnectAgentHue)(byId.get(agent.id)?.hue)
    return { ...agent, hue }
  })
}
