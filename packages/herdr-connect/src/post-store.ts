import { openPrivateSqlite, type PrivateSqlite } from "@knpkv/herdr-fleet/sqlite"
import { Effect, Schema, SchemaIssue, Semaphore } from "effect"
import type { DatabaseSync, SQLOutputValue } from "node:sqlite"
import { initializePosts } from "./internal/post-database.js"
import { makeSelfStateMethods } from "./internal/self-state-store.js"
import { connectBusyTimeoutMillis, connectSqliteWrite } from "./internal/sqlite-write.js"
import {
  Conflict,
  ConnectPost,
  ConnectPostBody,
  ConnectPostCursor,
  ConnectPostPage,
  connectPostPageMaxRecords,
  InvalidReport,
  Unavailable
} from "./posts.js"

export const connectPostRetentionMillis = 90 * 24 * 60 * 60 * 1000
export const connectPostsPerAgent = 128
const Row = Schema.Struct({
  sequence: Schema.Number,
  host: Schema.String,
  agent_id: Schema.String,
  event_id: Schema.String,
  kind: Schema.String,
  text: Schema.String,
  goal_step: Schema.NullOr(Schema.String),
  created_at: Schema.Number
})
const decodeRow = (input: Readonly<Record<string, SQLOutputValue>>): ConnectPost => {
  const row = Schema.decodeUnknownSync(Row)(input)
  const post = {
    sequence: row.sequence,
    host: row.host,
    agentId: row.agent_id,
    eventId: row.event_id,
    kind: row.kind,
    text: row.text,
    createdAt: row.created_at
  }
  return Schema.decodeUnknownSync(ConnectPost)(row.goal_step === null ? post : { ...post, goalStep: row.goal_step })
}
const unavailable = (operation: string) => () => new Unavailable({ operation })
const expiredPostBatchSize = 256

/** Each post write evicts one global batch, including its expired retry identity before reuse. */
const evictExpiredPosts = (
  database: DatabaseSync,
  host: string,
  agentId: string,
  eventId: string,
  now: number
): void => {
  const cutoff = now - connectPostRetentionMillis
  database.prepare(`WITH retry AS (
    SELECT sequence FROM connect_posts
    WHERE host = ? AND agent_id = ? AND event_id = ? AND created_at < ?
  ), expired AS (
    SELECT sequence FROM connect_posts
    WHERE created_at < ? AND sequence NOT IN (SELECT sequence FROM retry)
    ORDER BY created_at, sequence LIMIT ? - (SELECT COUNT(*) FROM retry)
  ) DELETE FROM connect_posts WHERE sequence IN (
    SELECT sequence FROM retry UNION ALL SELECT sequence FROM expired
  )`).run(host.toLowerCase(), agentId, eventId, cutoff, cutoff, expiredPostBatchSize)
}

const trimAgentPosts = (database: DatabaseSync, host: string, agentId: string): void => {
  database.prepare(`DELETE FROM connect_posts WHERE host = ? AND agent_id = ? AND sequence NOT IN (
    SELECT sequence FROM connect_posts WHERE host = ? AND agent_id = ? ORDER BY sequence DESC LIMIT ?
  )`).run(host.toLowerCase(), agentId, host.toLowerCase(), agentId, connectPostsPerAgent)
}

/** Bounded reports and latest creature self-state. Post retries use authenticated host, stable agent ID and event ID. */
export class AgentPostStore {
  readonly #database: DatabaseSync
  readonly #transactions: Semaphore.Semaphore
  readonly #secureFiles: PrivateSqlite["secureFiles"]
  readonly selfUpdate: ReturnType<typeof makeSelfStateMethods>["update"]
  readonly selfLatestMany: ReturnType<typeof makeSelfStateMethods>["latestMany"]
  readonly path: string
  private constructor(path: string, transactions: Semaphore.Semaphore, opened: PrivateSqlite) {
    this.path = path
    this.#database = opened.database
    this.#transactions = transactions
    this.#secureFiles = opened.secureFiles
    const self = makeSelfStateMethods(opened.database, transactions, opened.secureFiles)
    this.selfUpdate = self.update
    this.selfLatestMany = self.latestMany
  }
  static readonly open = Effect.fn("AgentPostStore.open")(function*(path: string) {
    const opened = yield* openPrivateSqlite(path, {
      busyTimeoutMillis: connectBusyTimeoutMillis,
      initialize: initializePosts
    }).pipe(
      Effect.mapError(unavailable("posts.open"))
    )
    return new AgentPostStore(path, yield* Semaphore.make(1), opened)
  })

  readonly post = Effect.fn("AgentPostStore.post")(function*(
    this: AgentPostStore,
    host: string,
    agentId: string,
    input: ConnectPostBody,
    now: number
  ) {
    const body = yield* Schema.decodeUnknownEffect(ConnectPostBody)(input).pipe(
      Effect.mapError((error) =>
        new InvalidReport({
          detail: SchemaIssue.makeFormatterStandardSchemaV1()(error.issue).issues
            .map(({ message, path }) => `${path?.map(String).join(".") || "post"} ${message}`)
            .join("; ")
        })
      )
    )
    yield* Schema.decodeUnknownEffect(ConnectPost)({ ...body, host, agentId, createdAt: now, sequence: 1 }).pipe(
      Effect.mapError(() => new InvalidReport({ detail: "invalid post identity or timestamp" }))
    )
    return yield* connectSqliteWrite(
      "posts.post",
      () => {
        this.#database.exec("BEGIN IMMEDIATE")
        try {
          evictExpiredPosts(this.#database, host, agentId, body.eventId, now)
          const previous = this.#database.prepare(
            "SELECT * FROM connect_posts WHERE host = ? AND agent_id = ? AND event_id = ?"
          ).get(host.toLowerCase(), agentId, body.eventId)
          if (previous !== undefined) {
            const post = decodeRow(previous)
            if (post.kind !== body.kind || post.text !== body.text || post.goalStep !== body.goalStep) {
              throw new Conflict({ eventId: body.eventId })
            }
            this.#database.exec("COMMIT")
            return post
          }
          const row = this.#database.prepare(`
            INSERT INTO connect_posts (host, agent_id, event_id, kind, text, goal_step, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *
          `).get(host.toLowerCase(), agentId, body.eventId, body.kind, body.text, body.goalStep ?? null, now)
          if (row === undefined) throw new Unavailable({ operation: "posts.insert" })
          const post = decodeRow(row)
          trimAgentPosts(this.#database, host, agentId)
          this.#database.exec("COMMIT")
          return post
        } catch (cause) {
          this.#database.exec("ROLLBACK")
          throw cause
        }
      },
      (cause) => Schema.is(Conflict)(cause) ? cause : new Unavailable({ operation: "posts.post" }),
      true,
      this.#transactions,
      () => this.#secureFiles.pipe(Effect.mapError(unavailable("posts.permissions")))
    )
  })

  /** WAL SELECTs must not queue behind writer backoff; secure lazy sidecars before returning. */
  readonly page = Effect.fn("AgentPostStore.page")(function*(
    this: AgentPostStore,
    host: string,
    agentId: string,
    input: ConnectPostCursor | null,
    now: number
  ) {
    const cursor = yield* Schema.decodeUnknownEffect(Schema.NullOr(ConnectPostCursor))(input).pipe(
      Effect.mapError(() => new InvalidReport({ detail: "invalid post cursor" }))
    )
    return yield* Effect.try({
      try: () => {
        const rows = this.#database.prepare(`SELECT * FROM connect_posts
          WHERE host = ? AND agent_id = ? AND sequence < ? AND created_at >= ? ORDER BY sequence DESC LIMIT ?`)
          .all(
            host.toLowerCase(),
            agentId,
            cursor?.sequence ?? Number.MAX_SAFE_INTEGER,
            now - connectPostRetentionMillis,
            connectPostPageMaxRecords + 1
          )
        const posts = rows.slice(0, connectPostPageMaxRecords).map(decodeRow)
        const last = posts.at(-1)
        return Schema.decodeUnknownSync(ConnectPostPage)({
          posts,
          nextCursor: rows.length > connectPostPageMaxRecords && last !== undefined
            ? { sequence: last.sequence }
            : null
        })
      },
      catch: unavailable("posts.page")
    }).pipe(Effect.tap(() => this.#secureFiles.pipe(Effect.mapError(unavailable("posts.permissions")))))
  })

  readonly latest = Effect.fn("AgentPostStore.latest")(function*(
    this: AgentPostStore,
    host: string,
    agentId: string,
    now: number
  ) {
    const posts = yield* this.latestMany([{ host, agentId }], now)
    return posts[0] ?? null
  })

  /** Reads only select retained rows; post writes own bounded global expiry eviction. */
  readonly latestMany = Effect.fn("AgentPostStore.latestMany")(function*(
    this: AgentPostStore,
    targets: ReadonlyArray<Pick<ConnectPost, "host" | "agentId">>,
    now: number
  ) {
    return yield* this.#transactions.withPermits(1)(
      Effect.try({
        try: () => {
          const query = this.#database.prepare(
            "SELECT * FROM connect_posts WHERE host = ? AND agent_id = ? AND created_at >= ? ORDER BY sequence DESC LIMIT 1"
          )
          return targets.flatMap(({ agentId, host }) => {
            const row = query.get(host.toLowerCase(), agentId, now - connectPostRetentionMillis)
            return row === undefined ? [] : [decodeRow(row)]
          })
        },
        catch: unavailable("posts.latest")
      }).pipe(Effect.tap(() => this.#secureFiles.pipe(Effect.mapError(unavailable("posts.permissions")))))
    )
  })

  close(): void {
    this.#database.close()
  }
}
