import { NodeServices } from "@effect/platform-node"
import { describe, expect, it, vi } from "@effect/vitest"
import { Clock, Deferred, Effect, Fiber, FileSystem, Logger, Option, Path, Ref, Result, Schema } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { TestClock } from "effect/testing"
import { DatabaseSync } from "node:sqlite"
import { AgentArchiveStore, ConnectArchiveObservation } from "../src/archive-store.js"
import { fleetConnectAgents } from "../src/directory.js"
import { ConnectArchiveStoreError, ConnectPeerError } from "../src/errors.js"
import {
  ArchivedConnectAgent,
  ConnectAgent,
  ConnectArchiveCursor,
  ConnectArchivePage,
  connectArchivePageMaxRecords,
  LocalConnectAgents
} from "../src/model.js"
import { AgentPostStore } from "../src/post-store.js"

const agent = (id = "agent-one", host = "HOST-A"): ConnectAgent =>
  Schema.decodeUnknownSync(ConnectAgent)({
    id,
    host,
    name: "worker",
    kind: "codex",
    work: "project",
    state: "working",
    lastActivityAt: 0,
    relationship: { parentAgentId: "agent-parent", relation: "pair" }
  })
const openStore = Effect.fn("ArchiveTest.open")(function*() {
  const fs = yield* FileSystem.FileSystem
  const paths = yield* Path.Path
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "connect-archive-" })
  return yield* Effect.acquireRelease(
    AgentArchiveStore.open(paths.join(directory, "archive.sqlite")),
    (store) => Effect.sync(() => store.close())
  )
})
const observe = (
  store: AgentArchiveStore,
  observedAt: number,
  agents: ReadonlyArray<ConnectAgent>,
  complete = true,
  host = "HOST-A"
) => store.observe({ host, agents, observedAt, complete })

const withDatabaseLock = Effect.fn("ArchiveTest.withDatabaseLock")(
  function*<A, E, R>(store: AgentArchiveStore, effect: Effect.Effect<A, E, R>) {
    const database = yield* Effect.acquireRelease(
      Effect.sync(() => new DatabaseSync(store.path)),
      (opened) => Effect.sync(() => opened.close())
    )
    yield* Effect.acquireRelease(
      Effect.sync(() => database.exec("BEGIN IMMEDIATE")),
      () => Effect.sync(() => database.exec("ROLLBACK"))
    )
    const pending = yield* Effect.forkScoped(effect)
    yield* TestClock.adjust(6_000)
    return yield* Fiber.join(pending)
  },
  Effect.scoped
)

const seedClosure = Effect.fn("ArchiveTest.seedClosure")(function*(store: AgentArchiveStore) {
  yield* observe(store, 0, [agent()])
  yield* observe(store, 1, [])
  yield* observe(store, 300_001, [])
})

describe("closed agent archive", () => {
  it.layer(NodeServices.layer)((it) => {
    it.effect("keeps optional observations outside the primary permit until file security finishes", () =>
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const armed = yield* Ref.make(false)
        const securing = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const delegated = FileSystem.FileSystem.of({
          ...fs,
          chmod: (path, mode) =>
            Effect.gen(function*() {
              yield* fs.chmod(path, mode)
              if (path.endsWith("archive.sqlite") && (yield* Ref.getAndSet(armed, false))) {
                yield* Deferred.succeed(securing, undefined)
                yield* Deferred.await(release)
              }
            })
        })
        const store = yield* openStore().pipe(Effect.provideService(FileSystem.FileSystem, delegated))
        yield* Ref.set(armed, true)
        const primary = yield* Effect.forkScoped(observe(store, 0, [agent()]))
        yield* Deferred.await(securing)
        const reader = yield* Effect.acquireRelease(
          Effect.sync(() => new DatabaseSync(store.path)),
          (database) => Effect.sync(() => database.close())
        )
        expect(reader.prepare("SELECT agent_id FROM connect_archive_observations").all()).toHaveLength(1)
        const absent = (observedAt: number) =>
          store.observeAvailable([{ host: "HOST-A", agents: [], complete: true, observedAt }])
        expect(yield* Effect.result(absent(1))).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "ConnectArchiveStoreError", operation: "observe.transaction" }
        })
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(primary)
        yield* absent(1)
        yield* absent(300_001)
        expect((yield* store.page()).agents).toEqual([])
        yield* absent(600_001)
        expect((yield* store.page()).agents).toHaveLength(1)
      }).pipe(Effect.scoped))

    it.effect("remembers an absent parent's latest name on its own host, before and after closure", () =>
      Effect.gen(function*() {
        const store = yield* openStore()
        const parent = ConnectAgent.make({
          id: "agent-parent",
          host: "HOST-A",
          name: "former coordinator",
          kind: "codex",
          work: "project",
          state: "working",
          lastActivityAt: 0
        })
        yield* observe(store, 0, [parent, agent()])
        const read = (observedAt: number) =>
          fleetConnectAgents(
            Effect.succeed(LocalConnectAgents.make({ host: "HOST-A", agents: [agent()], complete: true })),
            [],
            { store, observedAt }
          )
        expect((yield* read(1)).agents[0]?.relationship).toEqual({
          parentAgentId: "agent-parent",
          relation: "pair",
          parentName: "former coordinator"
        })
        expect((yield* read(300_001)).agents[0]?.relationship).toEqual({
          parentAgentId: "agent-parent",
          relation: "pair",
          parentName: "former coordinator"
        })
        expect((yield* store.page()).agents.map(({ name }) => name)).toEqual(["former coordinator"])
        const foreign = yield* fleetConnectAgents(
          Effect.succeed(
            LocalConnectAgents.make({ host: "HOST-B", agents: [agent("agent-foreign", "HOST-B")], complete: true })
          ),
          [],
          { store, observedAt: 300_002 }
        )
        expect(foreign.agents[0]?.relationship).toEqual({ parentAgentId: "agent-parent", relation: "pair" })
      }).pipe(
        Effect.provideService(HttpClient.HttpClient, HttpClient.make(() => Effect.die("No peers in this read"))),
        Effect.scoped
      ))

    it.effect("keeps the state directory and database files owner-only after writing", () =>
      Effect.gen(function*() {
        const store = yield* openStore()
        const fs = yield* FileSystem.FileSystem
        const paths = yield* Path.Path
        yield* seedClosure(store)
        if (paths.sep === "/") {
          expect((yield* fs.stat(paths.dirname(store.path))).mode & 0o777).toBe(0o700)
          for (const file of [store.path, `${store.path}-wal`, `${store.path}-shm`]) {
            if (yield* fs.exists(file)) expect((yield* fs.stat(file)).mode & 0o777).toBe(0o600)
          }
        }
      }).pipe(Effect.scoped))

    it.effect("archives only after two complete absent reads spanning five minutes", () =>
      Effect.gen(function*() {
        const store = yield* openStore()
        yield* observe(store, 0, [agent()])
        yield* observe(store, 100, [])
        yield* observe(store, 300_099, [])
        expect((yield* store.page()).agents).toEqual([])
        yield* observe(store, 300_100, [])
        expect((yield* store.page()).agents).toEqual([{
          host: "host-a",
          agentId: "agent-one",
          name: "worker",
          kind: "codex",
          work: "project",
          state: "working",
          firstSeenAt: 0,
          closedAt: 300_100,
          relationship: { parentAgentId: "agent-parent", relation: "pair" }
        }])
        yield* observe(store, 900_000, [])
        expect((yield* store.page()).agents[0]?.closedAt).toBe(300_100)
      }).pipe(Effect.scoped))

    it.effect("one absence after a long pause still needs a second read and five minutes from first absence", () =>
      Effect.gen(function*() {
        const store = yield* openStore()
        yield* observe(store, 0, [agent()])
        yield* observe(store, 900_000, [])
        expect((yield* store.page()).agents).toEqual([])
        yield* observe(store, 900_001, [])
        expect((yield* store.page()).agents).toEqual([])
        yield* observe(store, 1_200_000, [])
        expect((yield* store.page()).agents).toHaveLength(1)
      }).pipe(Effect.scoped))

    it.effect("outages and partial reads break only that host's consecutive absence evidence", () =>
      Effect.gen(function*() {
        const store = yield* openStore()
        yield* observe(store, 0, [agent()])
        yield* observe(store, 0, [agent("agent-two", "HOST-B")], true, "HOST-B")
        yield* observe(store, 1, [])
        yield* observe(store, 1, [], true, "HOST-B")
        yield* observe(store, 300_001, [], false)
        yield* observe(store, 300_001, [], true, "HOST-B")
        expect((yield* store.page()).agents.map(({ host }) => host)).toEqual(["host-b"])
        yield* observe(store, 600_001, [])
        yield* observe(store, 900_001, [agent("agent-unrelated")], false)
        yield* observe(store, 1_200_001, [])
        expect((yield* store.page()).agents.map(({ host }) => host)).toEqual(["host-b"])
        yield* observe(store, 1_500_001, [])
        expect((yield* store.page()).agents.map(({ agentId }) => agentId)).toEqual([
          "agent-one",
          "agent-unrelated",
          "agent-two"
        ])
      }).pipe(Effect.scoped))

    it.effect("live reads between brief disappearances reset evidence for stable identities", () =>
      Effect.gen(function*() {
        const store = yield* openStore()
        yield* observe(store, 0, [agent()])
        yield* observe(store, 1, [])
        yield* observe(store, 299_999, [])
        yield* observe(store, 300_000, [{ ...agent(), name: "restarted", kind: "claude" }])
        yield* observe(store, 300_001, [])
        yield* observe(store, 600_000, [])
        expect((yield* store.page()).agents).toEqual([])
        yield* observe(store, 600_001, [])
        expect((yield* store.page()).agents[0]).toMatchObject({ name: "restarted", kind: "claude", firstSeenAt: 0 })
      }).pipe(Effect.scoped))

    it.effect("the fleet hook counts complete peer reads even while local reads fail", () =>
      Effect.gen(function*() {
        const store = yield* openStore()
        const peers = [{ host: "HOST-B", agentsUrl: "http://host-b.test/agents", online: true, terminalUrl: null }]
        const client = (agents: ReadonlyArray<ConnectAgent>) =>
          HttpClient.make((request) =>
            Effect.succeed(
              HttpClientResponse.fromWeb(request, Response.json({ host: "HOST-B", agents, complete: true }))
            )
          )
        yield* fleetConnectAgents(Effect.succeed({ host: "HOST-A", agents: [agent()] }), peers, {
          store,
          observedAt: 0
        }).pipe(
          Effect.provideService(HttpClient.HttpClient, client([agent("agent-peer", "HOST-B")]))
        )
        const unavailable = Effect.fail(
          new ConnectPeerError({ host: "HOST-A", reason: "unavailable", cause: "incomplete inventory" })
        )
        for (const observedAt of [1, 300_001]) {
          const fleet = yield* fleetConnectAgents(unavailable, peers, { store, observedAt }).pipe(
            Effect.provideService(HttpClient.HttpClient, client([]))
          )
          expect(fleet.failures).toEqual([{ host: "HOST-A", reason: "unavailable" }])
        }
        expect((yield* store.page()).agents.map(({ agentId }) => agentId)).toEqual(["agent-peer"])
        yield* fleetConnectAgents(
          Effect.succeed(Schema.decodeUnknownSync(LocalConnectAgents)({ host: "HOST-A", agents: [] })),
          [{ ...peers[0], host: "HOST-B", agentsUrl: null, online: false, terminalUrl: null }],
          { store, observedAt: 600_001 }
        ).pipe(
          Effect.provideService(HttpClient.HttpClient, client([]))
        )
        expect((yield* store.page()).agents.map(({ agentId }) => agentId)).toEqual(["agent-peer"])
      }).pipe(Effect.scoped))

    it.effect("archive name lookup failures leave live directory rows available without remembered parent names", () =>
      Effect.gen(function*() {
        const store = yield* openStore()
        yield* Effect.acquireRelease(
          Effect.sync(() =>
            vi.spyOn(store, "namesFor").mockReturnValue(
              Effect.fail(new ConnectArchiveStoreError({ operation: "namesFor", cause: "unreadable database" }))
            )
          ),
          (spy) => Effect.sync(() => spy.mockRestore())
        )
        const logged: Array<{ readonly level: string; readonly message: string }> = []
        const logger = Logger.make<unknown, void>((entry) => {
          logged.push({ level: entry.logLevel, message: String(entry.message) })
        })
        const local = { host: "HOST-A", agents: [agent()], complete: true }
        const directory = yield* fleetConnectAgents(Effect.succeed(local), [], { store, observedAt: 0 }).pipe(
          Effect.provideService(HttpClient.HttpClient, HttpClient.make(() => Effect.die("unexpected peer request"))),
          Effect.withLogger(logger)
        )
        expect(directory).toEqual({ agents: local.agents, failures: [] })
        expect(directory.agents[0]?.relationship).not.toHaveProperty("parentName")
        expect(logged).toContainEqual({
          level: "Warn",
          message: expect.stringContaining("Connect archive name lookup failed")
        })
      }).pipe(Effect.scoped))

    it.effect("archive write failures leave live directory rows available", () =>
      Effect.gen(function*() {
        const store = yield* openStore()
        yield* Effect.acquireRelease(
          Effect.sync(() =>
            vi.spyOn(store, "observe").mockReturnValue(
              Effect.fail(
                new ConnectArchiveStoreError({ operation: "observe.transaction", cause: "unavailable database" })
              )
            )
          ),
          (spy) => Effect.sync(() => spy.mockRestore())
        )
        const local = { host: "HOST-A", agents: [agent()], complete: true }
        const directory = yield* fleetConnectAgents(Effect.succeed(local), [], { store, observedAt: 0 }).pipe(
          Effect.provideService(HttpClient.HttpClient, HttpClient.make(() => Effect.die("unexpected peer request")))
        )
        expect(directory).toEqual({ agents: local.agents, failures: [] })
      }).pipe(Effect.scoped))

    for (const complete of [true, false]) {
      it.effect(`failed ${complete ? "positive" : "partial"} reads restart absence evidence after SQLite recovers`, () =>
        Effect.gen(function*() {
          const store = yield* openStore()
          yield* observe(store, 0, [agent()])
          yield* observe(store, 1, [])
          const local = { host: "HOST-A", agents: complete ? [agent()] : [], complete }
          const directory = yield* withDatabaseLock(
            store,
            fleetConnectAgents(Effect.succeed(local), [], { store, observedAt: 150_000 }).pipe(
              Effect.provideService(HttpClient.HttpClient, HttpClient.make(() => Effect.die("unexpected peer request")))
            )
          )
          expect(directory).toEqual({ agents: local.agents, failures: [] })
          yield* observe(store, 300_001, [])
          expect((yield* store.page()).agents).toEqual([])
          yield* observe(store, 600_001, [])
          expect((yield* store.page()).agents[0]).toMatchObject({
            agentId: "agent-one",
            firstSeenAt: 0,
            closedAt: 600_001
          })
        }).pipe(Effect.scoped))
    }

    it.effect("older recovery reads cannot reuse evidence from before a failed later sighting", () =>
      Effect.gen(function*() {
        const store = yield* openStore()
        yield* observe(store, 0, [agent()])
        yield* observe(store, 1, [])
        yield* withDatabaseLock(store, Effect.result(observe(store, 150_000, [agent()])))
        yield* observe(store, 100_000, [])
        yield* observe(store, 400_000, [])
        expect((yield* store.page()).agents).toEqual([])
        yield* observe(store, 700_000, [])
        expect((yield* store.page()).agents[0]?.closedAt).toBe(700_000)
      }).pipe(Effect.scoped))

    it.effect("a failed write resets only its host while other hosts retain valid absence evidence", () =>
      Effect.gen(function*() {
        const store = yield* openStore()
        yield* observe(store, 0, [agent()])
        yield* observe(store, 0, [agent("agent-two", "HOST-B")], true, "HOST-B")
        yield* observe(store, 1, [])
        yield* observe(store, 1, [], true, "HOST-B")
        const failed = yield* withDatabaseLock(store, Effect.result(observe(store, 150_000, [agent()])))
        expect(Result.isFailure(failed) && failed.failure.operation).toBe("observe.transaction")
        yield* observe(store, 300_001, [])
        yield* observe(store, 300_001, [], true, "HOST-B")
        expect((yield* store.page()).agents.map(({ host }) => host)).toEqual(["host-b"])
      }).pipe(Effect.scoped))

    it.effect("cancelling a contended positive sighting resets absence evidence and releases the transaction", () =>
      Effect.gen(function*() {
        const store = yield* openStore()
        yield* observe(store, 0, [agent()])
        yield* observe(store, 1, [])
        const db = yield* Effect.acquireRelease(
          Effect.sync(() => new DatabaseSync(store.path)),
          (db) => Effect.sync(() => db.close())
        )
        let locked = false
        const unlock = (): void => {
          if (!locked) return
          db.exec("ROLLBACK")
          locked = false
        }
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            db.exec("BEGIN IMMEDIATE")
            locked = true
          }),
          () => Effect.sync(unlock)
        )
        const pending = yield* Effect.forkScoped(observe(store, 150_000, [agent()]))
        yield* TestClock.adjust(1)
        yield* Fiber.interrupt(pending)
        yield* Effect.sync(unlock)
        yield* observe(store, 300_001, [])
        expect((yield* store.page()).agents).toEqual([])
        yield* observe(store, 600_001, [])
        expect((yield* store.page()).agents[0]?.closedAt).toBe(600_001)
      }).pipe(Effect.scoped))

    it.effect.each([350_000, 300_001])(
      "a cancelled queued sighting cannot be erased by a retry at or before its time; positive %s",
      (positiveAt) =>
        Effect.gen(function*() {
          const store = yield* openStore()
          yield* observe(store, 0, [agent()])
          yield* observe(store, 1, [])
          const db = yield* Effect.acquireRelease(Effect.sync(() => new DatabaseSync(store.path)), (db) =>
            Effect.sync(() => db.close()))
          let locked = false
          const unlock = (): void => {
            if (!locked) {
              return
            }
            db.exec("ROLLBACK")
            locked = false
          }
          yield* Effect.acquireRelease(
            Effect.sync(() => {
              db.exec("BEGIN IMMEDIATE")
              locked = true
            }),
            () =>
              Effect.sync(unlock)
          )
          const older = yield* Effect.forkScoped(observe(store, 300_001, []))
          yield* TestClock.adjust(1)
          const positive = yield* Effect.forkScoped(observe(store, positiveAt, [agent()]))
          yield* TestClock.adjust(1)
          yield* Fiber.interrupt(positive)
          yield* Effect.sync(unlock)
          yield* TestClock.adjust(1_000)
          yield* Fiber.join(older)
          expect((yield* store.page()).agents).toEqual([])
          yield* observe(store, 600_001, [])
          expect((yield* store.page()).agents).toEqual([])
          yield* observe(store, 900_001, [])
          expect((yield* store.page()).agents[0]?.closedAt).toBe(900_001)
        }).pipe(Effect.scoped)
    )

    /** A second process's writer lock must expire as a named retryable busy failure, not an opaque archive error. */
    it.effect("reports a typed busy expiry when another connection owns the archive writer", () =>
      Effect.gen(function*() {
        const store = yield* openStore()
        yield* observe(store, 0, [agent()])
        const failed = yield* withDatabaseLock(store, Effect.result(observe(store, 1, [agent()])))
        expect(failed).toMatchObject({
          failure: { cause: { code: "ERR_SQLITE_ERROR", errcode: 5 } }
        })
        expect(failed).toMatchObject({
          failure: {
            _tag: "ConnectStoreBusyError",
            operation: "observe.transaction",
            timeoutMillis: 5_000
          }
        })
      }).pipe(Effect.scoped))

    it.effect("reopening requires fresh absence evidence and retains already archived rows", () =>
      Effect.gen(function*() {
        const store = yield* openStore()
        yield* seedClosure(store)
        yield* observe(store, 300_002, [agent("agent-later")])
        yield* observe(store, 300_003, [])
        const reopened = yield* Effect.acquireRelease(
          AgentArchiveStore.open(store.path),
          (opened) => Effect.sync(() => opened.close())
        )
        yield* observe(reopened, 600_003, [])
        expect((yield* reopened.page()).agents.map(({ agentId }) => agentId)).toEqual(["agent-one"])
        yield* observe(reopened, 900_003, [])
        expect((yield* reopened.page()).agents.map(({ agentId }) => agentId)).toEqual(["agent-later", "agent-one"])
        expect((yield* reopened.page()).agents.find(({ agentId }) => agentId === "agent-one")?.closedAt).toBe(300_001)
      }).pipe(Effect.scoped))

    it.effect("paged, truncated and legacy peer lists cannot supply absence evidence", () =>
      Effect.gen(function*() {
        const store = yield* openStore()
        const peer = { host: "HOST-B", agentsUrl: "http://host-b.test/agents", online: true, terminalUrl: null }
        yield* observe(store, 0, [agent("agent-later-page", "HOST-B")], true, "HOST-B")
        yield* observe(store, 1, [], true, "HOST-B")
        const firstPage = [agent("agent-first-page", "HOST-B")]
        const local = Effect.succeed({ host: "HOST-A", agents: [], complete: true })
        const responses = [
          { host: "HOST-B", agents: firstPage, complete: false, nextCursor: "page-two" },
          { host: "HOST-B", agents: firstPage, complete: true, nextCursor: "page-two" },
          { host: "HOST-B", agents: firstPage, complete: true, truncated: true },
          { host: "HOST-B", agents: firstPage }
        ]
        for (const [index, body] of responses.entries()) {
          const client = HttpClient.make((request) =>
            Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(body)))
          )
          const directory = yield* fleetConnectAgents(local, [peer], { store, observedAt: (index + 1) * 300_001 }).pipe(
            Effect.provideService(HttpClient.HttpClient, client)
          )
          expect(directory.agents).toEqual(firstPage)
          expect((yield* store.page()).agents).toEqual([])
        }
      }).pipe(Effect.scoped))

    it.effect("same host and stable id reappear without resetting firstSeenAt; updated work and relationships survive closure", () =>
      Effect.gen(function*() {
        const store = yield* openStore()
        yield* seedClosure(store)
        yield* observe(store, 400_000, [{
          ...agent(),
          host: "host-a",
          name: "renamed",
          work: "next project",
          state: "idle",
          relationship: { parentAgentId: "agent-next", relation: "review" }
        }])
        expect((yield* store.page()).agents).toEqual([])
        yield* observe(store, 400_001, [])
        yield* observe(store, 700_001, [])
        expect((yield* store.page()).agents[0]).toMatchObject({
          name: "renamed",
          work: "next project",
          state: "idle",
          firstSeenAt: 0,
          closedAt: 700_001,
          relationship: { parentAgentId: "agent-next", relation: "review" }
        })
      }).pipe(Effect.scoped))

    it.effect("partial positive sightings unarchive while failed or stale reads cannot close an agent", () =>
      Effect.gen(function*() {
        const store = yield* openStore()
        yield* seedClosure(store)
        yield* observe(store, 400_000, [agent()], false)
        yield* observe(store, 300_002, [])
        yield* observe(store, 400_000, [])
        yield* observe(store, 700_000, [], false)
        expect((yield* store.page()).agents).toEqual([])
        yield* observe(store, 700_001, [])
        yield* observe(store, 1_000_001, [])
        expect((yield* store.page()).agents).toHaveLength(1)
      }).pipe(Effect.scoped))

    it.effect("keeps equal ids on different hosts independent", () =>
      Effect.gen(function*() {
        const store = yield* openStore()
        yield* seedClosure(store)
        yield* observe(store, 400_000, [agent("agent-one", "HOST-B")], true, "HOST-B")
        expect((yield* store.page()).agents.map(({ host }) => host)).toEqual(["host-a"])
      }).pipe(Effect.scoped))

    it.effect("paginates by newest closure then host and stable id without duplicates", () =>
      Effect.gen(function*() {
        const store = yield* openStore()
        const agents = Array.from({ length: connectArchivePageMaxRecords + 2 }, (_, index) =>
          agent(`agent-${String(index).padStart(3, "0")}`))
        yield* observe(store, 0, agents)
        yield* observe(store, 1, [])
        yield* observe(store, 300_001, [])
        yield* observe(store, 400_000, [agent("agent-newer", "HOST-B")], true, "HOST-B")
        yield* observe(store, 400_001, [], true, "HOST-B")
        yield* observe(store, 700_001, [], true, "HOST-B")
        const first = yield* store.page()
        expect(first.agents).toHaveLength(connectArchivePageMaxRecords)
        expect(first.agents[0]?.agentId).toBe("agent-newer")
        expect(first.nextCursor).not.toBeNull()
        const second = yield* store.page(first.nextCursor)
        expect(second.agents).toHaveLength(3)
        expect(second.nextCursor).toBeNull()
        const ids = [...first.agents, ...second.agents].map(({ agentId }) =>
          agentId
        )
        expect(new Set(ids).size).toBe(67)
        expect(ids.slice(1)).toEqual(agents.map(({ id }) => id))
      }).pipe(Effect.scoped))

    it.effect("returns only closures in the inclusive 90-day window on initial and cursor pages", () =>
      Effect.gen(function*() {
        const store = yield* openStore()
        const day = 86_400_000
        const now = 100 * day
        yield* Effect.acquireRelease(Clock.currentTimeMillis, (original) => TestClock.setTime(original))
        yield* TestClock.setTime(now)
        for (
          const { days, id } of [
            { id: "agent-old", days: 91 },
            { id: "agent-boundary", days: 90 },
            { id: "agent-recent", days: 89 }
          ]
        ) {
          const closedAt = now - days * day
          yield* observe(store, closedAt - 300_002, [agent(id)])
          yield* observe(store, closedAt - 300_001, [])
          yield* observe(store, closedAt, [])
        }
        const first = yield* store.page()
        expect(first.agents.map(({ agentId }) => agentId)).toEqual(["agent-recent", "agent-boundary"])
        expect(first.nextCursor).toBeNull()
        const second = yield* store.page({ host: "host-a", agentId: "agent-recent", closedAt: now - 89 * day })
        expect(second.agents.map(({ agentId }) => agentId)).toEqual(["agent-boundary"])
        expect(second.nextCursor).toBeNull()
        const expired = yield* store.page({ host: "host-a", agentId: "agent-boundary", closedAt: now - 90 * day })
        expect(expired.agents).toEqual([])
        expect(expired.nextCursor).toBeNull()
        const olderCursor = yield* store.page({ host: "host-a", agentId: "agent-before", closedAt: now - 91 * day })
        expect(olderCursor.agents).toEqual([])
        expect(olderCursor.nextCursor).toBeNull()
      }).pipe(Effect.scoped))

    it.effect("retains records across reopening without age pruning", () =>
      Effect.gen(function*() {
        const store = yield* openStore()
        yield* seedClosure(store)
        const reopened = yield* Effect.acquireRelease(AgentArchiveStore.open(store.path), (opened) =>
          Effect.sync(() => opened.close()))
        yield* observe(reopened, 100_000_000_000, [])
        expect((yield* reopened.page()).agents[0]).toMatchObject({ firstSeenAt: 0, closedAt: 300_001 })
      }).pipe(Effect.scoped))

    it.effect("rejects foreign agents, oversized observations and malformed cursors through tagged failures", () =>
      Effect.gen(function*() {
        const store = yield* openStore()
        const foreign = yield* Effect.result(observe(store, 0, [agent("agent-foreign", "HOST-B")]))
        expect(Result.isFailure(foreign) && foreign.failure._tag).toBe("ConnectArchiveStoreError")
        const negative = yield* Effect.result(store.page({ closedAt: -1, host: "HOST-A", agentId: "agent-one" }))
        expect(Result.isFailure(negative) && negative.failure.operation).toBe("page.cursor")
        const large = yield* Effect.result(observe(store, 0, Array.from({ length: 257 }, () => agent())))
        expect(Result.isFailure(large) && large.failure.operation).toBe("observe.decode")
        expect((yield* store.page()).agents).toEqual([])
      }).pipe(Effect.scoped))
  })

  it("bounds archive records, pages, cursors and observation timestamps", () => {
    const closed = {
      host: "HOST-A",
      agentId: "agent-one",
      name: "worker",
      kind: "codex",
      work: "project",
      state: "idle",
      firstSeenAt: 1,
      closedAt: 2
    }
    expect(Schema.is(ArchivedConnectAgent)(closed)).toBe(true)
    for (
      const invalid of [{ ...closed, work: "x".repeat(257) }, { ...closed, work: "private/path" }, {
        ...closed,
        closedAt: 0
      }, { ...closed, firstSeenAt: -1 }]
    ) {
      expect(Schema.is(ArchivedConnectAgent)(invalid)).toBe(false)
    }
    expect(Schema.is(ConnectArchivePage)({ agents: Array.from({ length: 65 }, () => closed), nextCursor: null })).toBe(
      false
    )
    expect(Schema.is(ConnectArchiveCursor)({ host: "HOST-A", agentId: "agent-one", closedAt: 1.5 })).toBe(false)
    expect(Schema.is(ConnectArchiveObservation)({ host: "HOST-A", agents: [], observedAt: -1, complete: true })).toBe(
      false
    )
  })
})

/** Real time is the contract here: short native waits must leave the loop free for the competing writer. */
it.layer(NodeServices.layer, { excludeTestServices: true })((it) => {
  it.effect.each([false, true])(
    "live directory survives post-store contention; primary pending %s",
    (primaryPending) =>
      Effect.gen(function*() {
        const store = yield* openStore()
        const posts = yield* Effect.acquireRelease(
          AgentPostStore.open(store.path),
          (value) => Effect.sync(() => value.close())
        )
        const now = yield* Clock.currentTimeMillis
        const row = agent()
        yield* posts.post(row.host, row.id, { eventId: "event-live", kind: "status", text: "Ready" }, now)
        yield* posts.selfUpdate(row.host, row.id, { mood: "focused" }, now)
        const db = yield* Effect.acquireRelease(
          Effect.sync(() => new DatabaseSync(store.path)),
          (value) => Effect.sync(() => value.close())
        )
        yield* Effect.acquireRelease(
          Effect.sync(() => db.exec("BEGIN IMMEDIATE")),
          () => Effect.sync(() => db.exec("ROLLBACK"))
        )
        if (primaryPending) {
          yield* Effect.forkScoped(posts.selfUpdate(row.host, row.id, { mood: "waiting" }, now + 1), {
            startImmediately: true
          })
        }
        const warnings: Array<string> = []
        const logger = Logger.make<unknown, void>((entry) => {
          warnings.push(String(entry.message))
        })
        const started = yield* Clock.currentTimeMillis
        const directory = yield* fleetConnectAgents(
          Effect.succeed(LocalConnectAgents.make({ host: row.host, agents: [row], complete: true })),
          [],
          { store, posts, observedAt: now + 1 }
        ).pipe(
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make(() =>
              Effect.die(new ConnectArchiveStoreError({ operation: "fixture.peer", cause: "unexpected peer" }))
            )
          ),
          Effect.withLogger(logger),
          Effect.timeoutOption("2 seconds")
        )
        expect(Option.isSome(directory)).toBe(true)
        if (Option.isSome(directory)) {
          expect(directory.value.failures).toEqual([])
          if (primaryPending) expect(directory.value.agents).toEqual([row])
          else {expect(directory.value.agents).toMatchObject([{
              id: row.id,
              voice: { text: "Ready", createdAt: now },
              self: { mood: "focused", accessory: "none", at: now }
            }])}
        }
        expect((yield* Clock.currentTimeMillis) - started).toBeLessThan(500)
        expect(warnings.some((message) => message.includes("Connect voice enrichment failed"))).toBe(primaryPending)
      }).pipe(Effect.scoped),
    { timeout: 5_000 }
  )
  it.effect.each([true, false])(
    "bounds optional archive work across sixteen hosts; locked %s",
    (locked) =>
      Effect.gen(function*() {
        const store = yield* openStore()
        const observedAt = yield* Clock.currentTimeMillis
        const readings = Array.from({ length: 16 }, (_, index) =>
          LocalConnectAgents.make({
            host: `host-${String(index).padStart(2, "0")}`,
            complete: true,
            agents: [ConnectAgent.make({
              host: `host-${String(index).padStart(2, "0")}`,
              id: `agent-${String(index)}`,
              name: "Worker",
              kind: "test",
              state: "working",
              work: "Healthy agent",
              lastActivityAt: observedAt
            })]
          }))
        for (const reading of readings) {
          yield* store.observe({ ...reading, complete: true, observedAt })
          yield* store.observe({ ...reading, complete: true, agents: [], observedAt: observedAt + 1 })
        }
        const database = yield* Effect.acquireRelease(
          Effect.sync(() => new DatabaseSync(store.path)),
          (db) => Effect.sync(() => db.close())
        )
        let held = false
        const unlock = () => {
          if (held) {
            database.exec("ROLLBACK")
            held = false
          }
        }
        if (locked) {
          yield* Effect.acquireRelease(
            Effect.sync(() => {
              database.exec("BEGIN IMMEDIATE")
              held = true
            }),
            () => Effect.sync(unlock)
          )
        }
        const local = readings[0]
        if (local === undefined) {
          return yield* Effect.die(new ConnectArchiveStoreError({ operation: "fixture.local", cause: "missing local" }))
        }
        const client = HttpClient.make((request) => {
          const reading = readings.find(({ host }) => new URL(request.url).hostname === `${host}.example.test`)
          return reading === undefined
            ? Effect.die(new ConnectArchiveStoreError({ operation: "fixture.peer", cause: "unknown host" }))
            : Effect.succeed(HttpClientResponse.fromWeb(request, new Response(JSON.stringify(reading))))
        })
        const tickStarted = yield* Deferred.make<void>()
        const started = yield* Clock.currentTimeMillis
        const tick = yield* Effect.forkScoped(
          Deferred.succeed(tickStarted, undefined).pipe(
            Effect.andThen(Effect.sleep("25 millis")),
            Effect.andThen(Clock.currentTimeMillis)
          )
        )
        yield* Deferred.await(tickStarted)
        const directory = yield* fleetConnectAgents(
          Effect.succeed(local),
          readings.slice(1).map(({ host }) => ({
            host,
            online: true,
            agentsUrl: `https://${host}.example.test/agents`,
            terminalUrl: null
          })),
          { store, observedAt: observedAt + 150_000 }
        ).pipe(Effect.provideService(HttpClient.HttpClient, client))
        const completed = yield* Clock.currentTimeMillis
        expect(directory).toEqual({ agents: readings.flatMap(({ agents }) => agents), failures: [] })
        expect(completed - started).toBeLessThan(500)
        expect((yield* Fiber.join(tick)) - started).toBeLessThan(250)
        yield* Effect.sync(unlock)
        for (const reading of readings) {
          yield* store.observe({ ...reading, complete: true, agents: [], observedAt: observedAt + 300_001 })
        }
        expect((yield* store.page()).agents).toEqual([])
        for (const reading of readings) {
          yield* store.observe({ ...reading, complete: true, agents: [], observedAt: observedAt + 600_001 })
        }
        expect((yield* store.page()).agents).toHaveLength(16)
      }).pipe(Effect.scoped),
    { timeout: 10_000 }
  )
  /** Optional archive contention must not consume the live directory's ten-second deadline per host. */
  it.effect.each([false, true])(
    "serves three live hosts promptly while their optional archive writer is locked; primary pending %s",
    (primaryPending) =>
      Effect.gen(function*() {
        const store = yield* openStore()
        const database = yield* Effect.acquireRelease(
          Effect.sync(() => new DatabaseSync(store.path)),
          (opened) => Effect.sync(() => opened.close())
        )
        yield* Effect.acquireRelease(
          Effect.sync(() => database.exec("BEGIN IMMEDIATE")),
          () => Effect.sync(() => database.exec("ROLLBACK"))
        )
        const readings = ["HOST-A", "HOST-B", "HOST-C"].map((host) =>
          LocalConnectAgents.make({
            host,
            complete: true,
            agents: [ConnectAgent.make({
              id: `agent-${host.toLowerCase()}`,
              host,
              name: "Worker",
              kind: "test",
              state: "working",
              work: "Healthy live agent",
              lastActivityAt: 0
            })]
          })
        )
        const local = readings[0]
        if (local === undefined) {
          return yield* Effect.die(
            new ConnectArchiveStoreError({ operation: "fixture.local", cause: "local fixture is missing" })
          )
        }
        const peers = readings.slice(1).map(({ host }) => ({
          host,
          online: true,
          agentsUrl: `https://${host.toLowerCase()}.example.test/agents`,
          terminalUrl: null
        }))
        const client = HttpClient.make((request) => {
          const reading = readings.find(({ host }) =>
            new URL(request.url).hostname === `${host.toLowerCase()}.example.test`
          )
          if (reading === undefined) {
            return Effect.die(
              new ConnectArchiveStoreError({ operation: "fixture.peer", cause: "unknown fixture host" })
            )
          }
          return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(JSON.stringify(reading))))
        })
        const warnings: Array<{ readonly level: string; readonly message: string }> = []
        const logger = Logger.make<unknown, void>((entry) => {
          warnings.push({ level: entry.logLevel, message: String(entry.message) })
        })
        if (primaryPending) {
          yield* Effect.forkScoped(observe(store, 2, [agent()]), { startImmediately: true })
        }
        const started = yield* Clock.currentTimeMillis
        const directory = yield* fleetConnectAgents(Effect.succeed(local), peers, { store, observedAt: 1 }).pipe(
          Effect.provideService(HttpClient.HttpClient, client),
          Effect.withLogger(logger),
          Effect.timeoutOption("2 seconds")
        )
        expect(Option.isSome(directory)).toBe(true)
        if (Option.isSome(directory)) {
          expect(directory.value).toEqual({ agents: readings.flatMap(({ agents }) => agents), failures: [] })
        }
        expect((yield* Clock.currentTimeMillis) - started).toBeLessThan(1_500)
        expect(
          warnings.filter(({ level, message }) =>
            level === "Warn" && message.includes("Connect archive observation failed")
          )
        ).toHaveLength(1)
        expect(warnings.filter(({ message }) => message.includes("Connect archive name lookup failed"))).toHaveLength(
          primaryPending ? 1 : 0
        )
      }).pipe(Effect.scoped),
    { timeout: 5_000 }
  )
  it.effect(
    "retries a writer released after 300 ms while the event loop timer still runs",
    () =>
      Effect.gen(function*() {
        const store = yield* openStore()
        yield* observe(store, 0, [agent()])
        const database = yield* Effect.acquireRelease(
          Effect.sync(() => new DatabaseSync(store.path)),
          (opened) => Effect.sync(() => opened.close())
        )
        let released = false
        const unlock = (): void => {
          if (released) return
          database.exec("ROLLBACK")
          released = true
        }
        yield* Effect.acquireRelease(
          Effect.sync(() => database.exec("BEGIN IMMEDIATE")),
          () => Effect.sync(unlock)
        )
        const started = yield* Clock.currentTimeMillis
        const tickStarted = yield* Deferred.make<void>()
        const releaseStarted = yield* Deferred.make<void>()
        const tick = yield* Effect.forkScoped(
          Deferred.succeed(tickStarted, undefined).pipe(
            Effect.andThen(Effect.sleep("25 millis")),
            Effect.andThen(Clock.currentTimeMillis)
          )
        )
        const release = yield* Effect.forkScoped(
          Deferred.succeed(releaseStarted, undefined).pipe(
            Effect.andThen(Effect.sleep("300 millis")),
            Effect.andThen(Effect.sync(unlock)),
            Effect.andThen(Clock.currentTimeMillis)
          )
        )
        yield* Deferred.await(tickStarted)
        yield* Deferred.await(releaseStarted)
        yield* observe(store, 1, [agent()])
        const writtenAt = yield* Clock.currentTimeMillis
        const tickAt = yield* Fiber.join(tick)
        const releasedAt = yield* Fiber.join(release)
        expect(tickAt - started).toBeLessThan(250)
        expect(tickAt).toBeLessThan(releasedAt)
        expect(releasedAt - started).toBeGreaterThanOrEqual(290)
        expect(writtenAt).toBeGreaterThanOrEqual(releasedAt)
        expect(writtenAt - started).toBeLessThan(1_500)
        expect(yield* store.namesFor([{ host: "HOST-A", id: "agent-one" }])).toEqual([
          { host: "HOST-A", id: "agent-one", name: "worker" }
        ])
      }).pipe(Effect.scoped),
    { timeout: 10_000 }
  )
})
