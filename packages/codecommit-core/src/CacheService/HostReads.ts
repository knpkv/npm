/**
 * Existing-only cache attachment for host-local Code reads. No migrations, permission repair,
 * cache writes or audit deletion are exposed. Provider coordinates and audit entries stay private.
 * @module
 */
import * as LibsqlClient from "@effect/sql-libsql/LibsqlClient"
import * as Libsql from "@libsql/client"
import { Context, Effect, Layer, Schema } from "effect"
import * as Path from "effect/Path"
import * as Reactivity from "effect/reactivity/Reactivity"
import * as SqlClient from "effect/sql/SqlClient"
import * as Statement from "effect/sql/Statement"
import { AuditLogRepo, type NewAuditLogEntry } from "../PermissionService/AuditLog.js"
import { CacheError } from "./CacheError.js"
import { type HostCachedComments, type HostCommentsReadError, readHostComments } from "./internal/HostComments.js"
import { verifyExistingPrivateDatabasePath } from "./internal/PrivateDatabasePathNode.js"
import { CachedPullRequest } from "./repos/PullRequestRepo/internal.js"

export { HostCommentsReadError } from "./internal/HostComments.js"
export type { HostCachedComments } from "./internal/HostComments.js"

const MigrationRows = Schema.Array(Schema.Struct({ migrationId: Schema.Int }))
const QueueQuery = Schema.Struct({
  filter: Schema.Literals(["open", "reviews", "all"]),
  search: Schema.String.check(Schema.isMaxLength(256)),
  offset: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 10_000 })),
  profiles: Schema.NullOr(Schema.Array(Schema.String).check(Schema.isMaxLength(256)))
})
const cacheError = (operation: string) => <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.mapError((cause) => new CacheError({ operation, cause })))

/** Private persisted coordinates are exact selectors; queue visibility does not apply to a target. */
export interface HostCacheCoordinates {
  readonly accountId: string
  readonly region: string
  readonly repository: string
  readonly id: string
}

export interface HostCacheReads {
  readonly queue: (query: {
    readonly filter: "open" | "reviews" | "all"
    readonly search: string
    readonly offset: number
    readonly profiles: ReadonlyArray<string> | null
  }) => Effect.Effect<ReadonlyArray<CachedPullRequest>, CacheError>
  readonly exact: (coordinates: HostCacheCoordinates) => Effect.Effect<CachedPullRequest | null, CacheError>
  /** Existing owner comments only; null means no snapshot, never an empty conversation. */
  readonly comments: (
    coordinates: HostCacheCoordinates
  ) => Effect.Effect<HostCachedComments | null, CacheError | HostCommentsReadError>
  readonly log: (entry: NewAuditLogEntry) => Effect.Effect<void, CacheError>
}

/**
 * Retains verified descriptors for the caller's scope and refuses any migration set other than 1..25.
 * Audit schema verification and insertion share a tiny write transaction, before any provider call.
 * SQLite writer contention waits at most 500ms. Only read methods and audit append leave this module.
 */
export const attachHostCache = Effect.fn("CacheService.attachHostCache")(function*(database: string) {
  const path = yield* Path.Path
  const verifyIdentity = yield* verifyExistingPrivateDatabasePath(path.dirname(database), database)
  const liveClient = yield* Effect.acquireRelease(
    Effect.try({
      try: () => Libsql.createClient({ url: `file:${database}`, concurrency: 1, timeout: 500 }),
      catch: (cause) => new CacheError({ operation: "HostCache.open", cause })
    }),
    (client) => Effect.sync(() => client.close())
  )
  const reactivity = yield* Layer.build(Reactivity.layer)
  const sql = yield* LibsqlClient.make({
    liveClient,
    transformResultNames: (name) => name.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase())
  }).pipe(Effect.provideContext(reactivity))
  yield* verifyIdentity()

  const verifySchema = Effect.fn("HostCache.verifySchema")(function*() {
    yield* verifyIdentity()
    const rows = yield* sql`SELECT migration_id FROM effect_sql_migrations ORDER BY migration_id`.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(MigrationRows)),
      cacheError("HostCache.schema")
    )
    if (rows.length !== 25 || rows.some((row, index) => row.migrationId !== index + 1)) {
      return yield* new CacheError({ operation: "HostCache.schema", cause: "Unsupported owner cache schema" })
    }
  })
  yield* verifySchema()
  const auditContext = yield* Layer.build(
    AuditLogRepo.layer.pipe(Layer.provide(Layer.succeed(SqlClient.SqlClient, sql)))
  )
  const auditRepo = Context.get(auditContext, AuditLogRepo)
  const decodeRows = Schema.decodeUnknownEffect(Schema.Array(CachedPullRequest))

  return {
    queue: Effect.fn("HostCache.queue")(function*(query: Parameters<HostCacheReads["queue"]>[0]) {
      yield* Schema.decodeUnknownEffect(QueueQuery)(query).pipe(cacheError("HostCache.queueQuery"))
      yield* verifySchema()
      if (query.profiles !== null && query.profiles.length === 0) return []
      const conditions = [sql`1 = 1`]
      if (query.filter !== "all") conditions.push(sql`status = 'OPEN'`)
      if (query.filter === "reviews") {
        conditions.push(sql`(is_approved = 0 OR approval_baseline_known = 0 OR approval_unknown_reason IS NOT NULL)`)
      }
      if (query.search.length > 0) {
        conditions.push(
          sql`(instr(lower(title), lower(${query.search})) > 0 OR instr(lower(repository_name), lower(${query.search})) > 0)`
        )
      }
      if (query.profiles !== null) conditions.push(sql`account_profile IN ${sql.in(query.profiles)}`)
      const where = Statement.and(conditions)
      return yield* sql`SELECT * FROM pull_requests WHERE ${where} ORDER BY last_modified_date DESC, aws_account_id, account_region, repository_name, id LIMIT 51 OFFSET ${query.offset}`
        .pipe(
          Effect.flatMap(decodeRows),
          cacheError("HostCache.queue")
        )
    }),
    exact: Effect.fn("HostCache.exact")(function*(coordinates: HostCacheCoordinates) {
      yield* verifySchema()
      const rows =
        yield* sql`SELECT * FROM pull_requests WHERE aws_account_id = ${coordinates.accountId} AND account_region = ${coordinates.region} AND repository_name = ${coordinates.repository} AND id = ${coordinates.id} LIMIT 1`
          .pipe(
            Effect.flatMap(decodeRows),
            cacheError("HostCache.exact")
          )
      return rows[0] ?? null
    }),
    log: Effect.fn("HostCache.log")(function*(entry: NewAuditLogEntry) {
      yield* sql.withTransaction(Effect.gen(function*() {
        yield* verifySchema()
        yield* auditRepo.log(entry)
      })).pipe(cacheError("HostCache.audit"))
    }),
    comments: Effect.fn("HostCache.comments")(function*(coordinates: HostCacheCoordinates) {
      yield* verifySchema()
      return yield* readHostComments(sql, coordinates)
    })
  } satisfies HostCacheReads
})
