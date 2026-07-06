import { Context, Effect, Layer, Option, Schema } from "effect"
import type { Success } from "effect/Effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as SqlSchema from "effect/unstable/sql/SqlSchema"
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
    Effect.withSpan(`SyncMetadataRepo.${op}`)
  )

const makeSyncMetadataRepo = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient

  const getLastSyncedAt_ = SqlSchema.findOneOption({
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

  const service = {
    getLastSyncedAt: (accountId: string, region: string) =>
      getLastSyncedAt_({ accountId, region }).pipe(
        Effect.map(Option.map((r) => r.lastSyncedAt)),
        cacheError("getLastSyncedAt")
      ),

    update: (accountId: string, region: string) => update_({ accountId, region }).pipe(cacheError("update"))
  }
  return service
})

export interface SyncMetadataRepoShape extends Success<typeof makeSyncMetadataRepo> {}

export class SyncMetadataRepo extends Context.Service<
  SyncMetadataRepo,
  SyncMetadataRepoShape
>()("SyncMetadataRepo") {
  static readonly Default = Layer.effect(SyncMetadataRepo, makeSyncMetadataRepo).pipe(
    Layer.provide(DatabaseLive)
  )
}
