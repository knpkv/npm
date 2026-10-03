import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert, describe, it } from "@effect/vitest"
import { createClient } from "@libsql/client"
import * as Context from "effect/Context"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"

import { Database, databaseLayer } from "../../src/server/persistence/Database.js"
import { databaseDrainLayer } from "../../src/server/runtime/DatabaseDrain.js"
import { ServerLifecycle } from "../../src/server/runtime/ServerLifecycle.js"
import { fixtureWorkspaceIds, makePersistenceTestConfig } from "../persistence/fixtures.js"

const drainWithReader = Effect.fn("DatabaseDrainTest.drainWithReader")(function*(
  releaseBeforeDrain: boolean
) {
  const config = yield* makePersistenceTestConfig("control-center-database-drain-")
  const dependencies = Layer.merge(databaseLayer(config), ServerLifecycle.layer)
  const runtime = yield* Layer.build(
    databaseDrainLayer.pipe(Layer.provideMerge(dependencies))
  )
  const database = Context.get(runtime, Database)
  const lifecycle = Context.get(runtime, ServerLifecycle)
  const readerEntered = yield* Deferred.make<void>()
  const releaseReader = yield* Deferred.make<void>()

  yield* database.sql`PRAGMA wal_checkpoint(TRUNCATE)`
  // libSQL keeps a WAL read snapshot only inside a dedicated read transaction.
  const readerClient = yield* Effect.acquireRelease(
    Effect.sync(() => createClient({ url: config.databaseUrl })),
    (client) => Effect.sync(() => client.close())
  )
  const readerFiber = yield* Effect.acquireUseRelease(
    Effect.promise(() => readerClient.transaction("read")),
    (reader) =>
      Effect.promise(() => reader.execute("SELECT COUNT(*) AS workspaceCount FROM workspaces")).pipe(
        Effect.andThen(Deferred.succeed(readerEntered, undefined)),
        Effect.andThen(Deferred.await(releaseReader))
      ),
    (reader) => Effect.sync(() => reader.close())
  ).pipe(Effect.forkChild)
  yield* Deferred.await(readerEntered)
  yield* database.sql`INSERT INTO workspaces (
    workspace_id, display_name, revision, created_at, updated_at
  ) VALUES (
    ${fixtureWorkspaceIds.alpha}, 'Drain fixture', 1,
    '2026-07-18T05:00:00.000Z', '2026-07-18T05:00:00.000Z'
  )`

  if (releaseBeforeDrain) {
    yield* Deferred.succeed(releaseReader, undefined)
    yield* Fiber.join(readerFiber)
  }
  const result = yield* lifecycle.drainWithin("10 seconds")
  if (!releaseBeforeDrain) {
    yield* Deferred.succeed(releaseReader, undefined)
    yield* Fiber.join(readerFiber)
  }
  return result
})

describe("database drain", () => {
  it.effect("reports a busy WAL checkpoint as a hook failure", () =>
    Effect.scoped(Effect.gen(function*() {
      assert.deepStrictEqual(yield* drainWithReader(false), {
        _tag: "HooksFailed",
        hookIds: ["persistence.wal-checkpoint"]
      })
    })).pipe(Effect.provide(NodeServices.layer)))

  it.effect("reports drained after the WAL reader releases", () =>
    Effect.scoped(Effect.gen(function*() {
      assert.deepStrictEqual(yield* drainWithReader(true), { _tag: "Drained" })
    })).pipe(Effect.provide(NodeServices.layer)))
})
