/** SQL triggers read each store's own connection pragmas, including a per-connection busy timeout. */
import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import {
  AgentActivityStore,
  AgentArchiveStore,
  AgentPostStore,
  AgentRelationshipStore,
  ConnectAgent
} from "@knpkv/herdr-connect"
import { Clock, Effect, Fiber, FileSystem, Path, Result, Schema } from "effect"
import { DatabaseSync } from "node:sqlite"
import { BlockedPushStore } from "../src/blocked-push-store.js"
import { ApprovalAppStore } from "../src/store.js"

const agent = Schema.decodeUnknownSync(ConnectAgent)({
  host: "host-a",
  id: "agent-write",
  name: "Worker",
  kind: "test",
  state: "blocked",
  work: "Checking",
  lastActivityAt: 0
})
const assertConnectionPragmas = Effect.fn("ConnectSqliteTest.guard")(
  function*(path: string, table: string, timeout = 100) {
    const db = yield* Effect.acquireRelease(
      Effect.sync(() => new DatabaseSync(path)),
      (db) => Effect.sync(() => db.close())
    )
    db.exec(`CREATE TRIGGER connection_guard BEFORE INSERT ON ${table} BEGIN
    SELECT CASE WHEN (SELECT timeout FROM pragma_busy_timeout) != ${timeout} THEN RAISE(ABORT, 'unexpected busy_timeout') END;
    SELECT CASE WHEN (SELECT journal_mode FROM pragma_journal_mode) != 'wal' THEN RAISE(ABORT, 'journal_mode must be WAL') END;
    SELECT CASE WHEN (SELECT synchronous FROM pragma_synchronous) != 2 THEN RAISE(ABORT, 'synchronous must remain FULL') END;
  END;`)
  }
)

describe("Connect database connection policy", () => {
  it.layer(NodeServices.layer)((it) => {
    it.effect.each(["activity", "hue", "archive", "relationship", "posts", "self", "approval", "blocked-push"])(
      "%s writes use short busy waits, WAL and FULL under owner-only files",
      (kind) =>
        Effect.gen(function*() {
          const fs = yield* FileSystem.FileSystem
          const paths = yield* Path.Path
          const directory = yield* fs.makeTempDirectoryScoped({ prefix: "connect-sqlite-pragmas-" })
          const path = paths.join(directory, "connect.sqlite")
          switch (kind) {
            case "activity":
            case "hue": {
              const store = yield* Effect.acquireRelease(AgentActivityStore.open(path), (store) =>
                Effect.sync(() => store.close()))
              yield* assertConnectionPragmas(path, kind === "activity" ? "agent_activity" : "connect_agent_hues")
              if (kind === "activity") {
                yield* store.observe(agent.host, agent.id, 1, 1)
              } else yield* store.assignHues(agent.host, [agent], 1, true)
              break
            }
            case "archive": {
              const store = yield* Effect.acquireRelease(AgentArchiveStore.open(path), (store) =>
                Effect.sync(() =>
                  store.close()
                ))
              yield* assertConnectionPragmas(path, "connect_archive_observations")
              yield* store.observe({ host: agent.host, agents: [agent], observedAt: 1, complete: true })
              break
            }
            case "relationship": {
              const store = yield* Effect.acquireRelease(AgentRelationshipStore.open(path), (store) =>
                Effect.sync(() =>
                  store.close()
                ))
              yield* assertConnectionPragmas(path, "connect_agent_relationships")
              yield* store.persist(
                { host: agent.host, agentId: agent.id, paneId: "w1:p1", observedAt: 1 },
                "trusted_live_inventory"
              )
              break
            }
            case "posts":
            case "self": {
              const store = yield* Effect.acquireRelease(AgentPostStore.open(path), (store) =>
                Effect.sync(() =>
                  store.close()
                ))
              yield* assertConnectionPragmas(path, kind === "posts" ? "connect_posts" : "connect_self_state")
              if (kind === "posts") {
                yield* store.post(agent.host, agent.id, { eventId: "event-write", kind: "status", text: "Checked" }, 1)
              } else yield* store.selfUpdate(agent.host, agent.id, { mood: "focused" }, 1)
              break
            }
            case "approval": {
              const store = yield* Effect.acquireRelease(ApprovalAppStore.open(path), (store) =>
                Effect.sync(() =>
                  store.close()
                ))
              yield* assertConnectionPragmas(path, "push_subscriptions", 0)
              yield* store.putSubscription({
                endpoint: "https://push.example.test/device",
                expirationTime: null,
                keys: { auth: "auth_key", p256dh: "public_key" }
              }, "owner@example.test")
              break
            }
            case "blocked-push": {
              const store = yield* Effect.acquireRelease(BlockedPushStore.open(path), (store) =>
                Effect.sync(() =>
                  store.close()
                ))
              yield* assertConnectionPragmas(path, "blocked_push_hosts", 0)
              yield* store.observe({ host: agent.host, agents: [agent], observedAt: 1, complete: true })
              break
            }
          }
          if (paths.sep === "/") {
            expect((yield* fs.stat(directory)).mode & 0o777).toBe(0o700)
            for (const file of [path, `${path}-wal`, `${path}-shm`]) {
              expect((yield* fs.stat(file)).mode & 0o777).toBe(0o600)
            }
          }
        }).pipe(Effect.scoped)
    )
  })
})

it.layer(NodeServices.layer, { excludeTestServices: true })((it) => {
  it.effect("fails locked request writes without aggregating native waits on the event loop", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const paths = yield* Path.Path
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "request-store-contention-" })
      const path = paths.join(directory, "state.sqlite")
      const subscriptions = yield* Effect.acquireRelease(
        ApprovalAppStore.open(path),
        (store) => Effect.sync(() => store.close())
      )
      const blocked = yield* Effect.acquireRelease(
        BlockedPushStore.open(path),
        (store) => Effect.sync(() => store.close())
      )
      const writer = yield* Effect.acquireRelease(
        Effect.sync(() => new DatabaseSync(path)),
        (database) => Effect.sync(() => database.close())
      )
      yield* Effect.acquireRelease(
        Effect.sync(() => writer.exec("BEGIN IMMEDIATE")),
        () => Effect.sync(() => writer.exec("ROLLBACK"))
      )
      const started = yield* Clock.currentTimeMillis
      const timer = yield* Effect.forkScoped(Effect.sleep("20 millis").pipe(Effect.andThen(Clock.currentTimeMillis)))
      const results = yield* Effect.forEach(
        Array.from({ length: 16 }, (_, index) => index),
        (index) =>
          Effect.result(Effect.gen(function*() {
            if (index % 3 === 0) {
              yield* subscriptions.putSubscription({
                endpoint: `https://push.example.test/${index}`,
                expirationTime: null,
                keys: { auth: "auth_key", p256dh: "public_key" }
              }, "owner@example.test")
            } else if (index % 3 === 1) {
              yield* blocked.mutateSettings("owner@example.test", { _tag: "SetQuietHours", quietHours: null })
            } else {
              yield* blocked.heartbeat("owner@example.test", { clientId: `browser-${index}`, target: null })
            }
          })),
        { concurrency: "unbounded" }
      )
      expect(results.every(Result.isFailure)).toBe(true)
      for (const [index, result] of results.entries()) {
        expect(result).toMatchObject({
          failure: { _tag: index % 3 === 0 ? "ApprovalAppStoreError" : "BlockedPushStoreError" }
        })
      }
      expect((yield* Clock.currentTimeMillis) - started).toBeLessThan(250)
      expect((yield* Fiber.join(timer)) - started).toBeLessThan(250)
    }).pipe(Effect.scoped))
})
