import * as SqlClient from "@effect/sql/SqlClient"
import { Effect, Option } from "effect"
import { DatabaseLive } from "../Database.js"

export class SyncMetadataRepo extends Effect.Service<SyncMetadataRepo>()("SyncMetadataRepo", {
  dependencies: [DatabaseLive],
  effect: Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient

    return {
      getLastSyncedAt: (accountId: string, region: string) =>
        sql<{ lastSyncedAt: string }>`
          SELECT last_synced_at AS "lastSyncedAt" FROM sync_metadata
          WHERE account_id = ${accountId} AND account_region = ${region}
        `.pipe(
          Effect.map((rows) => rows.length > 0 ? Option.some(rows[0]!.lastSyncedAt) : Option.none()),
          Effect.orDie
        ),

      update: (accountId: string, region: string) =>
        sql`INSERT OR REPLACE INTO sync_metadata (account_id, account_region, last_synced_at)
            VALUES (${accountId}, ${region}, datetime('now'))
        `.pipe(Effect.asVoid, Effect.orDie)
    } as const
  })
}) {}
