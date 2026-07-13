import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Result, Schema } from "effect"
import * as FileSystem from "effect/FileSystem"

import { BUSY_TIMEOUT_MILLISECONDS, Database, databaseLayer } from "../../src/server/persistence/Database.js"
import { decodePersistenceConfig, PersistenceConfig } from "../../src/server/persistence/PersistenceConfig.js"

const testConfig = Effect.gen(function*() {
  const fileSystem = yield* FileSystem.FileSystem
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "control-center-database-" })
  return {
    blobRoot: `${root}/blobs`,
    busyTimeoutMilliseconds: 5_000,
    databaseUrl: `file:${root}/control-center.db`,
    maxConnections: 1
  }
})

describe("Database", () => {
  it.effect("configures and verifies required SQLite pragmas", () =>
    Effect.gen(function*() {
      const config = yield* testConfig
      const result = yield* Effect.gen(function*() {
        const database = yield* Database
        const foreignKeys = yield* database.sql<{ readonly foreignKeys: number }>`PRAGMA foreign_keys`
        const journalMode = yield* database.sql<{ readonly journalMode: string }>`PRAGMA journal_mode`
        const busyTimeout = yield* database.sql<{ readonly timeout: number }>`PRAGMA busy_timeout`

        return {
          busyTimeout: busyTimeout[0]?.timeout,
          foreignKeys: foreignKeys[0]?.foreignKeys,
          journalMode: journalMode[0]?.journalMode
        }
      }).pipe(Effect.provide(databaseLayer(config)))

      assert.deepStrictEqual(result, {
        busyTimeout: BUSY_TIMEOUT_MILLISECONDS,
        foreignKeys: 1,
        journalMode: "wal"
      })
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("serializes concurrent application migration acquisition", () =>
    Effect.gen(function*() {
      const config = yield* testConfig
      const acquire = Effect.gen(function*() {
        const database = yield* Database
        yield* database.validateMigrationLedger
      }).pipe(Effect.provide(databaseLayer(config)), Effect.scoped)

      const exits = yield* Effect.all(
        [acquire.pipe(Effect.exit), acquire.pipe(Effect.exit)],
        { concurrency: "unbounded" }
      )
      assert.isTrue(exits.every((exit) => exit._tag === "Success"))
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("rolls back a failed transaction", () =>
    Effect.gen(function*() {
      const config = yield* testConfig
      const rows = yield* Effect.gen(function*() {
        const database = yield* Database
        const insert = database.sql`INSERT INTO workspaces (
          workspace_id, display_name, revision, created_at, updated_at
        ) VALUES (
          '01890f6f-6d6a-7cc0-98d2-000000000001',
          'Payments',
          1,
          '2026-07-13T10:00:00.000Z',
          '2026-07-13T10:00:00.000Z'
        )`

        yield* database.transaction(insert.pipe(Effect.andThen(Effect.fail("rollback")))).pipe(
          Effect.ignore
        )
        return yield* database.sql`SELECT workspace_id FROM workspaces`
      }).pipe(Effect.provide(databaseLayer(config)))

      assert.deepStrictEqual(rows, [])
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("rejects an environment role without a matching release target", () =>
    Effect.gen(function*() {
      const config = yield* testConfig
      const outcome = yield* Effect.gen(function*() {
        const database = yield* Database
        yield* database.sql`INSERT INTO workspaces (
          workspace_id, display_name, revision, created_at, updated_at
        ) VALUES (
          '01890f6f-6d6a-7cc0-98d2-000000000001', 'Payments', 1,
          '2026-07-13T10:00:00.000Z', '2026-07-13T10:00:00.000Z'
        )`
        yield* database.sql`INSERT INTO releases (
          workspace_id, release_id, current_revision, created_at, updated_at
        ) VALUES (
          '01890f6f-6d6a-7cc0-98d2-000000000001',
          '01890f6f-6d6a-7cc0-98d2-000000000002', 1,
          '2026-07-13T10:00:00.000Z', '2026-07-13T10:00:00.000Z'
        )`
        return yield* database.sql`INSERT INTO role_assignments (
          workspace_id, assignment_id, actor_kind, agent_id, role, scope_kind,
          release_id, environment_id, lifecycle_kind, assigned_at,
          created_at, updated_at
        ) VALUES (
          '01890f6f-6d6a-7cc0-98d2-000000000001',
          '01890f6f-6d6a-7cc0-98d2-000000000003', 'agent',
          '01890f6f-6d6a-7cc0-98d2-000000000004', 'deployment-approver', 'environment',
          '01890f6f-6d6a-7cc0-98d2-000000000002',
          '01890f6f-6d6a-7cc0-98d2-000000000005', 'active',
          '2026-07-13T10:00:00.000Z',
          '2026-07-13T10:00:00.000Z', '2026-07-13T10:00:00.000Z'
        )`
      }).pipe(Effect.provide(databaseLayer(config)), Effect.result)

      assert.isTrue(Result.isFailure(outcome))
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("uses savepoints so a nested rollback does not discard the outer transaction", () =>
    Effect.gen(function*() {
      const config = yield* testConfig
      const rows = yield* Effect.gen(function*() {
        const database = yield* Database
        const insertFirst = database.sql`INSERT INTO workspaces (
          workspace_id, display_name, revision, created_at, updated_at
        ) VALUES (
          '01890f6f-6d6a-7cc0-98d2-000000000001',
          'Payments',
          1,
          '2026-07-13T10:00:00.000Z',
          '2026-07-13T10:00:00.000Z'
        )`
        const insertSecond = database.sql`INSERT INTO workspaces (
          workspace_id, display_name, revision, created_at, updated_at
        ) VALUES (
          '01890f6f-6d6a-7cc0-98d2-000000000002',
          'Identity',
          1,
          '2026-07-13T10:00:00.000Z',
          '2026-07-13T10:00:00.000Z'
        )`

        yield* database.transaction(
          insertFirst.pipe(
            Effect.andThen(
              database.transaction(insertSecond.pipe(Effect.andThen(Effect.fail("savepoint")))).pipe(
                Effect.ignore
              )
            )
          )
        )
        return yield* database.sql`SELECT workspace_id AS workspaceId FROM workspaces ORDER BY workspace_id`
      }).pipe(Effect.provide(databaseLayer(config)))

      assert.deepStrictEqual(rows, [
        { workspaceId: "01890f6f-6d6a-7cc0-98d2-000000000001" }
      ])
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it("rejects remote, ambiguous, concurrent, and control-character configuration", () => {
    const invalidInputs = [
      {
        blobRoot: "/tmp/control-center/blobs",
        busyTimeoutMilliseconds: 5_000,
        databaseUrl: "https://database.example/control-center",
        maxConnections: 1
      },
      {
        blobRoot: "relative/blobs",
        busyTimeoutMilliseconds: 5_000,
        databaseUrl: "file:/tmp/control-center.db",
        maxConnections: 1
      },
      {
        blobRoot: "/tmp/control-center/blobs",
        busyTimeoutMilliseconds: 5_000,
        databaseUrl: "file:relative.db",
        maxConnections: 1
      },
      {
        blobRoot: "/tmp/control-center/blobs",
        busyTimeoutMilliseconds: 5_000,
        databaseUrl: "file:/tmp/control-center.db",
        maxConnections: 2
      },
      {
        blobRoot: "/tmp/control-center\u0000/blobs",
        busyTimeoutMilliseconds: 5_000,
        databaseUrl: "file:/tmp/control-center.db",
        maxConnections: 1
      },
      {
        blobRoot: "/tmp/control-center/blobs",
        busyTimeoutMilliseconds: 5_000,
        databaseUrl: "file:/tmp/control-center%00.db",
        maxConnections: 1
      },
      {
        blobRoot: "/tmp/control-center/blobs",
        busyTimeoutMilliseconds: 5_000,
        databaseUrl: "file://remote-host/tmp/control-center.db",
        maxConnections: 1
      },
      {
        blobRoot: "/tmp/control-center/blobs",
        busyTimeoutMilliseconds: 5_000,
        databaseUrl: "file://user:secret@localhost/tmp/control-center.db",
        maxConnections: 1
      }
    ]

    for (const input of invalidInputs) {
      assert.isTrue(Result.isFailure(Schema.decodeUnknownResult(PersistenceConfig)(input)))
    }
  })

  it.effect("maps client connection defects to a redacted tagged error", () =>
    Effect.gen(function*() {
      const pathCanary = "review-path-canary"
      const outcome = yield* Effect.gen(function*() {
        yield* Database
      }).pipe(
        Effect.provide(
          databaseLayer({
            blobRoot: "/tmp/control-center/blobs",
            busyTimeoutMilliseconds: 5_000,
            databaseUrl: `file:/proc/${pathCanary}/control-center.db`,
            maxConnections: 1
          })
        ),
        Effect.exit
      )

      assert.isTrue(outcome._tag === "Failure")
      assert.notInclude(JSON.stringify(outcome), pathCanary)
      assert.include(JSON.stringify(outcome), "DatabaseInitializationError")
      assert.include(JSON.stringify(outcome), "connect")
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it("structurally excludes secret-shaped input and never echoes rejected values", () => {
    const secretCanary = "never-print-this-token"
    const decoded = Schema.decodeUnknownSync(PersistenceConfig)({
      authToken: secretCanary,
      blobRoot: "/tmp/control-center/blobs",
      busyTimeoutMilliseconds: 5_000,
      databaseUrl: "file:/tmp/control-center.db",
      maxConnections: 1
    })
    const rejected = Effect.runSync(
      decodePersistenceConfig({
        blobRoot: `/tmp/${secretCanary}\u0000/blobs`,
        busyTimeoutMilliseconds: 5_000,
        databaseUrl: "file:/tmp/control-center.db",
        maxConnections: 1
      }).pipe(Effect.result)
    )

    assert.notInclude(JSON.stringify(decoded), secretCanary)
    assert.notInclude(JSON.stringify(rejected), secretCanary)
  })

  it.effect("closes the scoped client before its temporary root is removed", () =>
    Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem
      const root = yield* fileSystem.makeTempDirectory({ prefix: "control-center-close-" })
      yield* Effect.addFinalizer(() => fileSystem.remove(root, { recursive: true }).pipe(Effect.ignore))
      const config = {
        blobRoot: `${root}/blobs`,
        busyTimeoutMilliseconds: 5_000,
        databaseUrl: `file:${root}/control-center.db`,
        maxConnections: 1
      }

      yield* Effect.gen(function*() {
        yield* Database
      }).pipe(Effect.provide(databaseLayer(config)), Effect.scoped)

      yield* fileSystem.remove(root, { recursive: true })
      assert.isFalse(yield* fileSystem.exists(root))
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))
})
