/**
 * @title AuditLogRepo — records every AWS API call
 *
 * Every call through the permission gate gets recorded — allowed, denied,
 * or timed out.
 *
 * Design constraints:
 *   - MUST never block API calls (catchAll on write failures at call site)
 *   - MUST handle high volume (~17 ops per refresh × every 5min)
 *   - MUST auto-prune (150k entries/month without pruning)
 *   - MUST support filtered queries (for the audit log UI page)
 *
 * `durationMs` is null when the API call was denied/timed out (never ran).
 * When present, it reflects actual AWS API latency — not permission prompt wait.
 *
 * @module
 */
import * as SqlClient from "@effect/sql/SqlClient"
import * as SqlSchema from "@effect/sql/SqlSchema"
import * as Statement from "@effect/sql/Statement"
import { Effect, Schema } from "effect"
import { CacheError } from "../CacheService/CacheError.js"
import { DatabaseLive } from "../CacheService/Database.js"

export const AuditLogEntry = Schema.Struct({
  id: Schema.Number,
  timestamp: Schema.String,
  operation: Schema.String,
  accountProfile: Schema.String,
  region: Schema.String,
  permissionState: Schema.Literal("allowed", "always_allowed", "denied", "timed_out"),
  context: Schema.String,
  durationMs: Schema.NullOr(Schema.Number)
})

export type AuditLogEntry = typeof AuditLogEntry.Type

export type NewAuditLogEntry = Omit<AuditLogEntry, "id">

export interface PaginatedAuditLog {
  readonly items: ReadonlyArray<AuditLogEntry>
  readonly total: number
  readonly nextCursor?: number
}

const cacheError = (op: string) => <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.mapError((cause) => new CacheError({ operation: `AuditLogRepo.${op}`, cause })),
    Effect.withSpan(`AuditLogRepo.${op}`, { captureStackTrace: false })
  )

export class AuditLogRepo extends Effect.Service<AuditLogRepo>()("AuditLogRepo", {
  dependencies: [DatabaseLive],
  effect: Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient

    const findAll_ = SqlSchema.findAll({
      Result: AuditLogEntry,
      Request: Schema.Struct({
        limit: Schema.Number,
        offset: Schema.Number
      }),
      execute: (req) => sql`SELECT * FROM audit_log ORDER BY id DESC LIMIT ${req.limit} OFFSET ${req.offset}`
    })

    const countAll = SqlSchema.single({
      Result: Schema.Struct({ count: Schema.Number }),
      Request: Schema.Void,
      execute: () => sql`SELECT count(*) as count FROM audit_log`
    })

    return {
      log: (entry: NewAuditLogEntry) =>
        sql`INSERT INTO audit_log (timestamp, operation, account_profile, region, permission_state, context, duration_ms)
            VALUES (${entry.timestamp}, ${entry.operation}, ${entry.accountProfile}, ${entry.region}, ${entry.permissionState}, ${entry.context}, ${entry.durationMs})`
          .pipe(
            Effect.asVoid,
            cacheError("log")
          ),

      findAll: (opts?: {
        readonly limit?: number | undefined
        readonly offset?: number | undefined
        readonly operation?: string | undefined
        readonly accountProfile?: string | undefined
        readonly permissionState?: string | undefined
        readonly from?: string | undefined
        readonly to?: string | undefined
        readonly search?: string | undefined
      }): Effect.Effect<PaginatedAuditLog, CacheError> => {
        // Clamp numeric params
        const limit = Math.max(1, Math.min(200, Math.floor(opts?.limit ?? 50)))
        const offset = Math.max(0, Math.floor(opts?.offset ?? 0))

        // Compose parameterized WHERE using Statement.and
        const hasFilter = opts?.operation || opts?.accountProfile || opts?.permissionState
          || opts?.from || opts?.to || opts?.search
        if (hasFilter) {
          const conditions: Array<Statement.Fragment> = []
          if (opts?.operation) conditions.push(sql`operation = ${opts.operation}`)
          if (opts?.accountProfile) conditions.push(sql`account_profile = ${opts.accountProfile}`)
          if (opts?.permissionState) conditions.push(sql`permission_state = ${opts.permissionState}`)
          if (opts?.from) conditions.push(sql`timestamp >= ${opts.from}`)
          if (opts?.to) conditions.push(sql`timestamp <= ${opts.to}`)
          if (opts?.search) {
            const pattern = `%${opts.search}%`
            conditions.push(sql`(operation LIKE ${pattern} OR context LIKE ${pattern})`)
          }
          const where = Statement.and(conditions)

          return Effect.all([
            sql`SELECT * FROM audit_log WHERE ${where} ORDER BY id DESC LIMIT ${limit} OFFSET ${offset}`.pipe(
              Effect.map((rows) => rows.map((r) => Schema.decodeUnknownSync(AuditLogEntry)(r)))
            ),
            sql`SELECT count(*) as count FROM audit_log WHERE ${where}`.pipe(
              Effect.map((rows) => (rows[0] as unknown as { count: number })?.count ?? 0)
            )
          ]).pipe(
            Effect.map(([items, total]) => ({
              items,
              total,
              ...(items.length === limit ? { nextCursor: offset + limit } : {})
            })),
            cacheError("findAll")
          )
        }

        return Effect.all([
          findAll_({ limit, offset }),
          countAll(undefined as void)
        ]).pipe(
          Effect.map(([items, { count }]) => ({
            items,
            total: count,
            ...(items.length === limit ? { nextCursor: offset + limit } : {})
          })),
          cacheError("findAll")
        )
      },

      prune: (retentionDays: number): Effect.Effect<number, CacheError> => {
        const days = Math.max(1, Math.floor(retentionDays))
        return sql.unsafe(
          `DELETE FROM audit_log WHERE timestamp < datetime('now', '-${days} days')`
        ).pipe(
          // DELETE returns no rows — use changes() to get actual deleted count
          Effect.flatMap(() => sql<{ n: number }>`SELECT changes() as n`),
          Effect.map((rows) => rows[0]?.n ?? 0),
          cacheError("prune")
        )
      },

      clearAll: (): Effect.Effect<number, CacheError> =>
        sql`DELETE FROM audit_log`.pipe(
          Effect.flatMap(() => sql<{ n: number }>`SELECT changes() as n`),
          Effect.map((rows) => rows[0]?.n ?? 0),
          cacheError("clearAll")
        ),

      exportAll: (opts?: {
        readonly from?: string | undefined
        readonly to?: string | undefined
      }): Effect.Effect<ReadonlyArray<AuditLogEntry>, CacheError> => {
        const exportAllQuery = SqlSchema.findAll({
          Result: AuditLogEntry,
          Request: Schema.Void,
          execute: () => sql`SELECT * FROM audit_log ORDER BY id DESC`
        })
        if (opts?.from && opts?.to) {
          const exportFiltered = SqlSchema.findAll({
            Result: AuditLogEntry,
            Request: Schema.Void,
            execute: () =>
              sql`SELECT * FROM audit_log WHERE timestamp >= ${opts.from!} AND timestamp <= ${opts
                .to!} ORDER BY id DESC`
          })
          return exportFiltered(undefined as void).pipe(cacheError("exportAll"))
        }
        return exportAllQuery(undefined as void).pipe(cacheError("exportAll"))
      }
    }
  })
}) {}
