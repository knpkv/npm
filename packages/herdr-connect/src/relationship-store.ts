import { Effect, Schema } from "effect"
import { DatabaseSync, type SQLOutputValue } from "node:sqlite"
import { ConnectRelationshipError, ConnectRelationshipStoreError } from "./errors.js"
import { ConnectAgent, ConnectAgentRelationship } from "./model.js"

export const PersistedConnectAgentMetadata = Schema.Struct({
  agentId: ConnectAgent.fields.id,
  host: ConnectAgent.fields.host,
  observedAt: Schema.Number.check(
    Schema.isInt(),
    Schema.isBetween({ minimum: 0, maximum: 8_640_000_000_000_000 })
  ),
  paneId: Schema.String.check(
    Schema.isMaxLength(64),
    Schema.isPattern(/^w[0-9A-Z]+:p[0-9A-Z]+$/)
  ),
  relationship: Schema.optionalKey(ConnectAgentRelationship)
})
export type PersistedConnectAgentMetadata = typeof PersistedConnectAgentMetadata.Type

export type RelationshipObservationSource = "durable_worker" | "trusted_live_inventory"

const RelationshipRow = Schema.Struct({
  agent_id: Schema.String,
  host: Schema.String,
  observed_at: Schema.Number,
  parent_agent_id: Schema.NullOr(Schema.String),
  pane_id: Schema.String,
  relation: Schema.NullOr(Schema.String)
})

const storeError = (operation: string) => (cause: unknown) => new ConnectRelationshipStoreError({ cause, operation })

const decodeRow = Effect.fn("AgentRelationshipStore.decodeRow")(function*(
  row: Readonly<Record<string, SQLOutputValue>> | undefined
) {
  const decoded = yield* Schema.decodeUnknownEffect(RelationshipRow)(row).pipe(
    Effect.mapError(storeError("decode"))
  )
  const metadata = decoded.parent_agent_id === null || decoded.relation === null
    ? {
      agentId: decoded.agent_id,
      host: decoded.host,
      observedAt: decoded.observed_at,
      paneId: decoded.pane_id
    }
    : {
      agentId: decoded.agent_id,
      host: decoded.host,
      observedAt: decoded.observed_at,
      paneId: decoded.pane_id,
      relationship: {
        parentAgentId: decoded.parent_agent_id,
        relation: decoded.relation
      }
    }
  return yield* Schema.decodeUnknownEffect(PersistedConnectAgentMetadata)(
    metadata
  ).pipe(Effect.mapError(storeError("decode.metadata")))
})

const sameMetadata = (
  left: PersistedConnectAgentMetadata,
  right: PersistedConnectAgentMetadata
): boolean =>
  left.agentId === right.agentId &&
  left.host === right.host &&
  left.paneId === right.paneId &&
  left.relationship?.parentAgentId === right.relationship?.parentAgentId &&
  left.relationship?.relation === right.relationship?.relation

export class AgentRelationshipStore {
  readonly #database: DatabaseSync
  readonly path: string

  private constructor(path: string) {
    this.path = path
    this.#database = new DatabaseSync(path)
    try {
      this.#database.exec(`
        CREATE TABLE IF NOT EXISTS connect_store_metadata (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS connect_agent_relationships (
          host TEXT NOT NULL COLLATE NOCASE,
          agent_id TEXT NOT NULL,
          pane_id TEXT NOT NULL,
          parent_agent_id TEXT,
          relation TEXT,
          observed_at INTEGER NOT NULL,
          PRIMARY KEY (host, agent_id),
          CHECK ((parent_agent_id IS NULL) = (relation IS NULL))
        );
      `)
      const version = this.#database.prepare(
        "SELECT value FROM connect_store_metadata WHERE key = 'relationship_schema'"
      ).get()
      const decodedVersion = Schema.decodeUnknownResult(
        Schema.Struct({ value: Schema.String })
      )(version)
      if (decodedVersion._tag === "Failure" || decodedVersion.success.value !== "3") {
        this.#database.exec(`
          BEGIN IMMEDIATE;
          CREATE TABLE connect_agent_relationships_v2 (
            host TEXT NOT NULL COLLATE NOCASE,
            agent_id TEXT NOT NULL,
            pane_id TEXT NOT NULL,
            parent_agent_id TEXT,
            relation TEXT,
            observed_at INTEGER NOT NULL,
            PRIMARY KEY (host, agent_id),
            CHECK ((parent_agent_id IS NULL) = (relation IS NULL))
          );
          INSERT INTO connect_agent_relationships_v2
            (host, agent_id, pane_id, parent_agent_id, relation, observed_at)
          SELECT host, agent_id, pane_id, parent_agent_id, relation, observed_at
          FROM connect_agent_relationships;
          DROP TABLE connect_agent_relationships;
          ALTER TABLE connect_agent_relationships_v2 RENAME TO connect_agent_relationships;
          INSERT INTO connect_store_metadata (key, value)
          VALUES ('relationship_schema', '3')
          ON CONFLICT(key) DO UPDATE SET value = excluded.value;
          COMMIT;
        `)
      }
    } catch (error) {
      this.#database.close()
      throw error
    }
  }

  static readonly open = Effect.fn("AgentRelationshipStore.open")(
    (path: string) =>
      Effect.try({
        try: () => new AgentRelationshipStore(path),
        catch: storeError("open")
      })
  )

  readonly persist = Effect.fn("AgentRelationshipStore.persist")(function*(
    this: AgentRelationshipStore,
    metadata: PersistedConnectAgentMetadata,
    source: RelationshipObservationSource
  ) {
    const row = yield* Effect.try({
      try: () => {
        this.#database.exec("BEGIN IMMEDIATE")
        try {
          const changed = this.#database.prepare(
            `INSERT INTO connect_agent_relationships
              (agent_id, host, pane_id, parent_agent_id, relation, observed_at)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(host, agent_id) DO UPDATE SET
               parent_agent_id = excluded.parent_agent_id,
               relation = excluded.relation,
               observed_at = excluded.observed_at
             WHERE connect_agent_relationships.pane_id = excluded.pane_id
               AND (
                 (
                   connect_agent_relationships.parent_agent_id IS excluded.parent_agent_id
                   AND connect_agent_relationships.relation IS excluded.relation
                   AND excluded.observed_at >= connect_agent_relationships.observed_at
                 )
                 OR (
                   ? = 'trusted_live_inventory'
                   AND excluded.observed_at > connect_agent_relationships.observed_at
                 )
               )
             RETURNING agent_id, host, pane_id, parent_agent_id, relation, observed_at`
          ).get(
            metadata.agentId,
            metadata.host,
            metadata.paneId,
            metadata.relationship?.parentAgentId ?? null,
            metadata.relationship?.relation ?? null,
            metadata.observedAt,
            source
          )
          const stored = changed ?? this.#database.prepare(
            `SELECT agent_id, host, pane_id, parent_agent_id, relation, observed_at
             FROM connect_agent_relationships
             WHERE host = ? AND agent_id = ?`
          ).get(metadata.host, metadata.agentId)
          this.#database.exec("COMMIT")
          return stored
        } catch (error) {
          this.#database.exec("ROLLBACK")
          throw error
        }
      },
      catch: storeError("persist")
    })
    const persisted = yield* decodeRow(row)
    if (!sameMetadata(persisted, metadata)) {
      return yield* new ConnectRelationshipError({
        detail: `agent ${metadata.agentId} already has different relationship ownership`,
        reason: "ambiguous_ownership"
      })
    }
    return persisted
  })

  readonly list = Effect.fn("AgentRelationshipStore.list")(function*(
    this: AgentRelationshipStore
  ) {
    const rows = yield* Effect.try({
      try: () =>
        this.#database.prepare(
          `SELECT agent_id, host, pane_id, parent_agent_id, relation, observed_at
         FROM connect_agent_relationships
         ORDER BY host, agent_id`
        ).all(),
      catch: storeError("list")
    })
    return yield* Effect.forEach(rows, decodeRow)
  })

  close(): void {
    this.#database.close()
  }
}
