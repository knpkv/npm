import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

import { Database, type DatabaseShape } from "../persistence/Database.js"
import { ServerLifecycle } from "./ServerLifecycle.js"

const WalCheckpointRow = Schema.Struct({
  busy: Schema.Number,
  checkpointed: Schema.Number,
  log: Schema.Number
})

const checkpointWal = Effect.fn("DatabaseDrain.checkpointWal")(function*(database: DatabaseShape) {
  const rows = yield* database.sql`PRAGMA wal_checkpoint(TRUNCATE)`
  const decoded = yield* Schema.decodeUnknownEffect(Schema.Array(WalCheckpointRow))(rows)
  if (decoded.length !== 1 || decoded[0]?.busy !== 0) {
    return yield* Effect.die("SQLite WAL checkpoint remained busy")
  }
})

/** Register the local SQLite checkpoint behind the shared lifecycle seam. */
export const databaseDrainLayer = Layer.effectDiscard(
  Effect.gen(function*() {
    const database = yield* Database
    const lifecycle = yield* ServerLifecycle

    yield* lifecycle.registerDrainHook({
      hookId: "persistence.wal-checkpoint",
      run: checkpointWal(database).pipe(Effect.orDie)
    })
  })
)
