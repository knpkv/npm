import { NodeServices } from "@effect/platform-node"
import { describe, expect, it, vi } from "@effect/vitest"
import { Effect, FileSystem, Path, Result, Schema } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
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
    return yield* effect
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
