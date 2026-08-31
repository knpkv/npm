import { Effect, Exit, FileSystem, Path, Schema, Semaphore } from "effect"
import { DatabaseSync, type SQLOutputValue } from "node:sqlite"
import { ConnectRelationshipError, ConnectRelationshipStoreError } from "./errors.js"
import { validateConnectRelationships } from "./forest.js"
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

export interface RelationshipObservation {
  readonly metadata: PersistedConnectAgentMetadata
  readonly source: RelationshipObservationSource
}

const RelationshipRow = Schema.Struct({
  agent_id: Schema.String,
  host: Schema.String,
  observed_at: Schema.Number,
  parent_agent_id: Schema.NullOr(Schema.String),
  pane_id: Schema.String,
  relation: Schema.NullOr(Schema.String),
  source: Schema.Literals(["durable_worker", "trusted_live_inventory"])
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
  const decodedMetadata = yield* Schema.decodeUnknownEffect(PersistedConnectAgentMetadata)(
    metadata
  ).pipe(Effect.mapError(storeError("decode.metadata")))
  return { metadata: decodedMetadata, source: decoded.source }
})

const sameMetadata = (
  left: PersistedConnectAgentMetadata,
  right: PersistedConnectAgentMetadata
): boolean =>
  left.agentId === right.agentId &&
  left.host.toLowerCase() === right.host.toLowerCase() &&
  left.paneId === right.paneId &&
  left.relationship?.parentAgentId === right.relationship?.parentAgentId &&
  left.relationship?.relation === right.relationship?.relation

export class AgentRelationshipStore {
  readonly #database: DatabaseSync
  readonly #transactions: Semaphore.Semaphore
  readonly path: string

  private constructor(path: string, transactions: Semaphore.Semaphore) {
    this.path = path
    this.#transactions = transactions
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
      if (
        decodedVersion._tag === "Failure" ||
        (decodedVersion.success.value !== "3" && decodedVersion.success.value !== "4")
      ) {
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
      const migratedVersion = this.#database.prepare(
        "SELECT value FROM connect_store_metadata WHERE key = 'relationship_schema'"
      ).get()
      const decodedMigratedVersion = Schema.decodeUnknownResult(
        Schema.Struct({ value: Schema.String })
      )(migratedVersion)
      if (decodedMigratedVersion._tag === "Failure" || decodedMigratedVersion.success.value !== "4") {
        this.#database.exec(`
          BEGIN IMMEDIATE;
          ALTER TABLE connect_agent_relationships
          ADD COLUMN source TEXT NOT NULL DEFAULT 'durable_worker'
          CHECK (source IN ('durable_worker', 'trusted_live_inventory'));
          INSERT INTO connect_store_metadata (key, value)
          VALUES ('relationship_schema', '4')
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
    function*(path: string) {
      const fileSystem = yield* FileSystem.FileSystem
      const paths = yield* Path.Path
      const directory = paths.dirname(path)
      yield* fileSystem.makeDirectory(directory, { recursive: true, mode: 0o700 }).pipe(
        Effect.mapError(storeError("open.directory"))
      )
      yield* fileSystem.chmod(directory, 0o700).pipe(
        Effect.mapError(storeError("open.secureDirectory"))
      )
      const transactions = yield* Semaphore.make(1)
      return yield* Effect.try({
        try: () => new AgentRelationshipStore(path, transactions),
        catch: storeError("open")
      })
    }
  )

  readonly persist = Effect.fn("AgentRelationshipStore.persist")(function*(
    this: AgentRelationshipStore,
    metadata: PersistedConnectAgentMetadata,
    source: RelationshipObservationSource
  ) {
    const stored = yield* this.persistAll([{ metadata, source }])
    const persisted = stored.find(
      (candidate) =>
        candidate.agentId === metadata.agentId &&
        candidate.host.toLowerCase() === metadata.host.toLowerCase()
    )
    if (persisted === undefined) {
      return yield* new ConnectRelationshipStoreError({
        cause: metadata,
        operation: "persist.result"
      })
    }
    return persisted
  })

  readonly persistAll = Effect.fn("AgentRelationshipStore.persistAll")(function*(
    this: AgentRelationshipStore,
    observations: ReadonlyArray<RelationshipObservation>
  ) {
    const database = this.#database
    const listUnlocked = this.listUnlocked()
    return yield* this.#transactions.withPermits(1)(
      Effect.acquireUseRelease(
        Effect.try({
          try: () => database.exec("BEGIN IMMEDIATE"),
          catch: storeError("persist.begin")
        }),
        () =>
          Effect.gen(function*() {
            const acceptedObservations: Array<RelationshipObservation> = []
            for (const { metadata, source } of observations) {
              const currentObservation = yield* Effect.try({
                try: () => {
                  const changed = database.prepare(
                    `INSERT INTO connect_agent_relationships
              (agent_id, host, pane_id, parent_agent_id, relation, observed_at, source)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(host, agent_id) DO UPDATE SET
               parent_agent_id = excluded.parent_agent_id,
               relation = excluded.relation,
               observed_at = excluded.observed_at,
               source = excluded.source
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
             RETURNING agent_id, host, pane_id, parent_agent_id, relation, observed_at, source`
                  ).get(
                    metadata.agentId,
                    metadata.host,
                    metadata.paneId,
                    metadata.relationship?.parentAgentId ?? null,
                    metadata.relationship?.relation ?? null,
                    metadata.observedAt,
                    source,
                    source
                  )
                  return changed ?? database.prepare(
                    `SELECT agent_id, host, pane_id, parent_agent_id, relation, observed_at, source
             FROM connect_agent_relationships
             WHERE host = ? AND agent_id = ?`
                  ).get(metadata.host, metadata.agentId)
                },
                catch: storeError("persist.upsert")
              }).pipe(Effect.flatMap(decodeRow))
              const current = currentObservation.metadata
              const staleDurableLoser = source === "durable_worker" &&
                currentObservation.source === "trusted_live_inventory" &&
                current.paneId === metadata.paneId &&
                current.observedAt > metadata.observedAt &&
                !sameMetadata(current, metadata)
              if (!staleDurableLoser) acceptedObservations.push({ metadata, source })
            }
            const persisted = yield* listUnlocked
            const finalObservations = new Map<string, PersistedConnectAgentMetadata>()
            for (const { metadata } of acceptedObservations) {
              finalObservations.set(`${metadata.host.toLowerCase()}\u0000${metadata.agentId}`, metadata)
            }
            for (const metadata of finalObservations.values()) {
              const current = persisted.find(
                (candidate) =>
                  candidate.agentId === metadata.agentId &&
                  candidate.host.toLowerCase() === metadata.host.toLowerCase()
              )
              if (current === undefined || !sameMetadata(current, metadata)) {
                return yield* new ConnectRelationshipError({
                  detail: `agent ${metadata.agentId} already has different relationship ownership`,
                  reason: "ambiguous_ownership"
                })
              }
            }
            yield* validateConnectRelationships(
              persisted.map(({ agentId: id, host, relationship }) =>
                relationship === undefined ? { host, id } : { host, id, relationship }
              )
            )
            return persisted
          }),
        (_, exit) =>
          Effect.try({
            try: () => database.exec(Exit.isSuccess(exit) ? "COMMIT" : "ROLLBACK"),
            catch: storeError(Exit.isSuccess(exit) ? "persist.commit" : "persist.rollback")
          })
      )
    )
  })

  readonly list = Effect.fn("AgentRelationshipStore.list")(function*(
    this: AgentRelationshipStore
  ) {
    return yield* this.#transactions.withPermits(1)(this.listUnlocked())
  })

  private listUnlocked() {
    const database = this.#database
    return Effect.gen(function*() {
      const rows = yield* Effect.try({
        try: () =>
          database.prepare(
            `SELECT agent_id, host, pane_id, parent_agent_id, relation, observed_at, source
             FROM connect_agent_relationships
             ORDER BY host, agent_id`
          ).all(),
        catch: storeError("list")
      })
      const observations = yield* Effect.forEach(rows, decodeRow)
      return observations.map(({ metadata }) => metadata)
    })
  }

  close(): void {
    this.#database.close()
  }
}
