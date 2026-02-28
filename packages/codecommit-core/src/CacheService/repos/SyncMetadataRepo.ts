import * as SqlClient from "@effect/sql/SqlClient"
import * as SqlSchema from "@effect/sql/SqlSchema"
import { Effect, Option, Schema } from "effect"
import { CacheError } from "../CacheError.js"
import { DatabaseLive } from "../Database.js"

const SyncRow = Schema.Struct({
  lastSyncedAt: Schema.String
})

const AccountRegion = Schema.Struct({
  accountId: Schema.String,
  region: Schema.String
})

const cacheError = (op: string) => <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.mapError((cause) => new CacheError({ operation: `SyncMetadataRepo.${op}`, cause })),
    Effect.withSpan(`SyncMetadataRepo.${op}`, { captureStackTrace: false })
  )

export class SyncMetadataRepo extends Effect.Service<SyncMetadataRepo>()("SyncMetadataRepo", {
  dependencies: [DatabaseLive],
  effect: Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient

    const getLastSyncedAt_ = SqlSchema.findOne({
      Result: SyncRow,
      Request: AccountRegion,
      execute: (req) =>
        sql`SELECT last_synced_at FROM sync_metadata
            WHERE account_id = ${req.accountId} AND account_region = ${req.region}`
    })

    const update_ = SqlSchema.void({
      Request: AccountRegion,
      execute: (req) =>
        sql`INSERT OR REPLACE INTO sync_metadata (account_id, account_region, last_synced_at)
            VALUES (${req.accountId}, ${req.region}, datetime('now'))`
    })

    return {
      getLastSyncedAt: (accountId: string, region: string) =>
        getLastSyncedAt_({ accountId, region }).pipe(
          Effect.map(Option.map((r) => r.lastSyncedAt)),
          cacheError("getLastSyncedAt")
        ),

      update: (accountId: string, region: string) => update_({ accountId, region }).pipe(cacheError("update"))
    } as const
  })
}) {}
