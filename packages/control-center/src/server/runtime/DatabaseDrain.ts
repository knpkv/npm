import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"

import { Database } from "../persistence/Database.js"
import { ServerLifecycle } from "./ServerLifecycle.js"

/** Register the local SQLite checkpoint behind the shared lifecycle seam. */
export const databaseDrainLayer = Layer.effectDiscard(
  Effect.gen(function*() {
    const { sql } = yield* Database
    const lifecycle = yield* ServerLifecycle

    yield* lifecycle.registerDrainHook({
      hookId: "persistence.wal-checkpoint",
      run: sql`PRAGMA wal_checkpoint(TRUNCATE)`.pipe(Effect.asVoid, Effect.orDie)
    })
  })
)
