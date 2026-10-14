import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import type { HostConfiguration } from "@knpkv/herdr-fleet"
import { Deferred, Effect, Fiber, FileSystem, Path, Ref, Result, Schema } from "effect"
import { TestClock } from "effect/testing"
import { DatabaseSync } from "node:sqlite"
import { AgentActivityStore } from "../src/activity-store.js"
import { AgentArchiveStore } from "../src/archive-store.js"
import { type AgentSource, localConnectAgents } from "../src/directory.js"
import { type ConnectHueEnrichment, makeConnectHueEnrichment } from "../src/hue-enrichment.js"
import { connectPeerDirectoryTimeoutMillis } from "../src/internal/peer-deadline.js"
import { type ArchivedConnectAgent, ConnectAgent } from "../src/model.js"
import { AgentRelationshipStore } from "../src/relationship-store.js"

const configuration = (stateDirectory: string, host = "atlas"): HostConfiguration => ({
  allowedUsers: ["owner@example.test"],
  applyCommand: null,
  browserMcpRecoverCommand: null,
  applyMachines: [host],
  approvalHub: { host, nodeId: "node-test", url: "https://hub.example.test/" },
  approvalNodes: ["node-test"],
  approvalPort: 4779,
  approvalTls: null,
  checkCommand: ["true"],
  coordinatorCommand: ["true"],
  crossHost: false,
  herdrCommand: "herdr",
  host,
  localPort: 4777,
  machines: [{ host, nodeId: "node-test" }],
  port: 4778,
  pushAllowedOrigins: ["https://hub.example.test"],
  pushSubject: "mailto:owner@example.test",
  repository: stateDirectory,
  stateDirectory,
  tailscaleCommand: "tailscale"
})
const pathFor = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const paths = yield* Path.Path
  return paths.join(yield* fs.makeTempDirectoryScoped({ prefix: "connect-hues-" }), "state.sqlite")
})
const openStores = Effect.fn("HueTest.open")(function*(path: string) {
  const activity = yield* Effect.acquireRelease(
    AgentActivityStore.open(path),
    (store) => Effect.sync(() => store.close())
  )
  const relationships = yield* Effect.acquireRelease(
    AgentRelationshipStore.open(path),
    (store) => Effect.sync(() => store.close())
  )
  const archive = yield* Effect.acquireRelease(
    AgentArchiveStore.open(path),
    (store) => Effect.sync(() => store.close())
  )
  return { activity, relationships, archive }
})
type Stores = Effect.Success<ReturnType<typeof openStores>>
interface Identity {
  readonly id: string
  readonly name: string
}
const identity = (name: string): Identity => ({ id: `agent-${name}`, name })
const read = (
  stores: Stores,
  entries: ReadonlyArray<Identity>,
  observedAt = 0,
  host = "atlas",
  complete = true,
  available = true,
  hueEnrichment?: ConnectHueEnrichment
) => {
  const source: AgentSource = {
    workers: () => Effect.succeed([]),
    agents: () =>
      Effect.succeed({
        available,
        error: complete ? null : "partial inventory",
        agents: entries.map(({ id, name }) => ({
          activityRevision: 1,
          agentId: id,
          kind: "codex",
          name,
          paneId: `w1:p${
            String([...id].reduce((hash, char) => Math.imul(hash ^ char.charCodeAt(0), 16777619), 2166136261) >>> 0)
          }`,
          parentAgentId: null,
          relation: null,
          status: "working",
          work: "project"
        }))
      })
  }
  return localConnectAgents(
    configuration(stores.activity.path, host),
    source,
    stores.activity,
    stores.relationships,
    observedAt,
    hueEnrichment
  )
}
const hueOf = (row: ConnectAgent | ArchivedConnectAgent | undefined): string =>
  Schema.decodeUnknownSync(Schema.Struct({ hue: Schema.String }))(row).hue
const close = (stores: Stores, agents: ReadonlyArray<ConnectAgent>, start = 0) =>
  Effect.gen(function*() {
    yield* stores.archive.observe({ host: "atlas", agents, observedAt: start, complete: true })
    yield* stores.archive.observe({ host: "atlas", agents: [], observedAt: start + 1, complete: true })
    yield* stores.archive.observe({ host: "atlas", agents: [], observedAt: start + 300_001, complete: true })
  })

describe("persisted agent hues", () => {
  it.layer(NodeServices.layer)((it) => {
    it.effect("returns the uncoloured directory before the peer deadline while hue chmod is held", () =>
      Effect.gen(function*() {
        const path = yield* pathFor
        const fs = yield* FileSystem.FileSystem
        const securing = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        let afterChmod = (_file: string): Effect.Effect<void> => Effect.void
        const delegated = FileSystem.FileSystem.of({
          ...fs,
          chmod: (file, mode) => fs.chmod(file, mode).pipe(Effect.andThen(Effect.suspend(() => afterChmod(file))))
        })
        const stores = yield* openStores(path)
        const hues = yield* makeConnectHueEnrichment(path).pipe(Effect.provideService(FileSystem.FileSystem, delegated))
        const reader = yield* Effect.acquireRelease(
          Effect.sync(() => new DatabaseSync(path)),
          (database) => Effect.sync(() => database.close())
        )
        yield* read(stores, [identity("worker")])
        afterChmod = (file) =>
          Effect.gen(function*() {
            if (file !== path) return
            const rows = reader.prepare("SELECT observed_at FROM connect_hue_hosts").all()
            if (rows[0]?.observed_at !== 1) return
            yield* Deferred.succeed(securing, undefined)
            yield* Deferred.await(release)
          })
        yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined))
        const pending = yield* Effect.forkScoped(read(stores, [identity("worker")], 1, "atlas", true, true, hues))
        yield* Deferred.await(securing)
        yield* TestClock.adjust(connectPeerDirectoryTimeoutMillis / 2)
        expect(pending.pollUnsafe()).toBeDefined()
        const result = yield* Fiber.join(pending)
        expect(result.agents).toHaveLength(1)
        expect(result.agents[0]?.hue).toBeUndefined()
        const repeated = yield* read(stores, [identity("worker")], 2, "atlas", true, true, hues)
        expect(repeated.agents[0]?.lastActivityAt).toBe(0)
        expect(repeated.agents[0]?.hue).toBeUndefined()
        expect(reader.prepare("SELECT observed_at FROM connect_hue_hosts").all()).toEqual([{ observed_at: 1 }])
        yield* Deferred.succeed(release, undefined)
      }).pipe(Effect.scoped))

    it.effect("does not call committed hues busy while permission finalization outlives their lock budget", () =>
      Effect.gen(function*() {
        const path = yield* pathFor
        const fs = yield* FileSystem.FileSystem
        const armed = yield* Ref.make(false)
        const securing = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const delegated = FileSystem.FileSystem.of({
          ...fs,
          chmod: (file, mode) =>
            Effect.gen(function*() {
              yield* fs.chmod(file, mode)
              if (file === path && (yield* Ref.getAndSet(armed, false))) {
                yield* Deferred.succeed(securing, undefined)
                yield* Deferred.await(release)
              }
            })
        })
        const stores = yield* openStores(path).pipe(Effect.provideService(FileSystem.FileSystem, delegated))
        const initial = yield* read(stores, [identity("worker")])
        const reader = yield* Effect.acquireRelease(
          Effect.sync(() => new DatabaseSync(path)),
          (database) => Effect.sync(() => database.close())
        )
        yield* Ref.set(armed, true)
        const pending = yield* Effect.forkScoped(Effect.result(
          stores.activity.assignHues("atlas", initial.agents, 1, true)
        ))
        yield* Deferred.await(securing)
        expect(reader.prepare("SELECT observed_at FROM connect_hue_hosts").all()).toEqual([{ observed_at: 1 }])
        yield* TestClock.adjust(connectPeerDirectoryTimeoutMillis)
        expect(pending.pollUnsafe()).toBeUndefined()
        yield* Deferred.succeed(release, undefined)
        const result = yield* Fiber.join(pending)
        expect(Result.isSuccess(result)).toBe(true)
        if (Result.isSuccess(result)) expect(result.success).toEqual(initial.agents)
      }).pipe(Effect.scoped))

    it.effect("bounds optional hue contention below the peer directory deadline and recovers after unlock", () =>
      Effect.gen(function*() {
        const stores = yield* openStores(yield* pathFor)
        const initial = yield* read(stores, [identity("worker")])
        const writer = yield* Effect.acquireRelease(
          Effect.sync(() => new DatabaseSync(stores.activity.path)),
          (database) => Effect.sync(() => database.close())
        )
        let locked = true
        yield* Effect.acquireRelease(Effect.sync(() => writer.exec("BEGIN IMMEDIATE")), () =>
          Effect.sync(() => {
            if (locked) writer.exec("ROLLBACK")
          }))
        const pending = yield* Effect.forkScoped(
          Effect.result(stores.activity.assignHues("atlas", initial.agents, 1, true))
        )
        yield* TestClock.adjust(connectPeerDirectoryTimeoutMillis - 1)
        expect(pending.pollUnsafe()).toBeDefined()
        expect(yield* Fiber.join(pending)).toMatchObject({
          failure: {
            _tag: "ConnectStoreBusyError",
            operation: "activity.hues.assign",
            timeoutMillis: connectPeerDirectoryTimeoutMillis / 2
          }
        })
        yield* Effect.sync(() => writer.exec("ROLLBACK"))
        locked = false
        expect((yield* read(stores, [identity("worker")], 2)).agents).toEqual(initial.agents)
      }).pipe(Effect.scoped))

    it.effect("assigns colliding names different families in stable identity order", () =>
      Effect.gen(function*() {
        const stores = yield* openStores(yield* pathFor)
        const result = yield* read(stores, [identity("skills"), identity("sec-cc")])
        expect(result.agents).toEqual(expect.arrayContaining([
          expect.objectContaining({ name: "sec-cc", hue: "rose" }),
          expect.objectContaining({ name: "skills", hue: "ember" })
        ]))
      }).pipe(Effect.scoped))

    it.effect("matches the design fixture assignments without reserving the chef palette", () =>
      Effect.gen(function*() {
        const stores = yield* openStores(yield* pathFor)
        const atlas = yield* read(stores, ["skills", "sec-cc", "pair-codex", "ds-rly"].map(identity))
        const birch = yield* read(stores, ["pkgsrc", "rev-usage"].map(identity), 0, "birch")
        expect([...atlas.agents, ...birch.agents]).toEqual(expect.arrayContaining([
          expect.objectContaining({ name: "ds-rly", hue: "iris" }),
          expect.objectContaining({ name: "sec-cc", hue: "rose" }),
          expect.objectContaining({ name: "pair-codex", hue: "moss" }),
          expect.objectContaining({ name: "skills", hue: "ember" }),
          expect.objectContaining({ name: "pkgsrc", hue: "ember" }),
          expect.objectContaining({ name: "rev-usage", hue: "moss" })
        ]))
      }).pipe(Effect.scoped))

    it.effect("releases peer-owned families from its complete inventory without hub database writes", () =>
      Effect.gen(function*() {
        const peer = yield* openStores(yield* pathFor)
        const hub = yield* openStores(yield* pathFor)
        const entries = [
          identity("sec-cc"),
          ...Array.from({ length: 7 }, (_, index) => identity(`worker-${String(index)}`))
        ]
        const initial = yield* read(peer, entries)
        yield* hub.archive.observe({ host: "atlas", agents: initial.agents, observedAt: 0, complete: true })
        yield* read(peer, [], 1)
        yield* hub.archive.observe({ host: "atlas", agents: [], observedAt: 1, complete: true })
        yield* hub.archive.observe({ host: "atlas", agents: [], observedAt: 300_001, complete: true })
        expect((yield* hub.archive.page()).agents).toHaveLength(8)
        const replacement = yield* read(peer, [identity("skills")], 300_002)
        expect(replacement.agents[0]).toHaveProperty("hue", "rose")
        expect((yield* hub.archive.page()).agents.find(({ agentId }) => agentId === "agent-sec-cc"))
          .toHaveProperty("hue", "rose")
      }).pipe(Effect.scoped))

    it.effect("ranks a retired family by its latest closure across all historical holders", () =>
      Effect.gen(function*() {
        const stores = yield* openStores(yield* pathFor)
        const entries = [
          identity("sec-cc"),
          ...Array.from({ length: 7 }, (_, index) => identity(`worker-${String(index)}`))
        ]
        yield* read(stores, entries)
        yield* read(stores, [], 1)
        expect((yield* read(stores, [identity("rose-reused")], 2)).agents[0]).toHaveProperty("hue", "rose")
        yield* read(stores, [], 100)
        // Rose's first holder closed at 1, but its latest holder closed at 100; ember has waited longer.
        expect((yield* read(stores, [identity("next-family")], 101)).agents[0]).toHaveProperty("hue", "ember")
      }).pipe(Effect.scoped))

    it.effect("leaves released families for returning identities while unused palettes remain", () =>
      Effect.gen(function*() {
        const stores = yield* openStores(yield* pathFor)
        const first = yield* read(stores, [identity("sec-cc")])
        yield* close(stores, first.agents)
        const next = yield* read(stores, [identity("skills")], 300_002)
        expect(next.agents[0]).toHaveProperty("hue", "ember")
        expect((yield* stores.archive.page()).agents[0]).toHaveProperty("hue", "rose")
        const returned = yield* read(stores, [identity("sec-cc"), identity("skills")], 300_003)
        expect(returned.agents.find(({ id }) => id === "agent-sec-cc")).toHaveProperty("hue", "rose")
      }).pipe(Effect.scoped))

    it.effect("prefers unused families so a complete-inventory restart blip keeps its old free family", () =>
      Effect.gen(function*() {
        const stores = yield* openStores(yield* pathFor)
        expect((yield* read(stores, [identity("sec-cc")])).agents[0]).toHaveProperty("hue", "rose")
        yield* read(stores, [], 1)
        expect((yield* read(stores, [identity("skills")], 2)).agents[0]).toHaveProperty("hue", "ember")
        const returned = yield* read(stores, [identity("sec-cc"), identity("skills")], 3)
        expect(returned.agents).toEqual(expect.arrayContaining([
          expect.objectContaining({ id: "agent-sec-cc", hue: "rose" }),
          expect.objectContaining({ id: "agent-skills", hue: "ember" })
        ]))
      }).pipe(Effect.scoped))

    for (const absence of Schema.Literals(["partial", "offline", "equal-time"]).literals) {
      it.effect(`retains peer reservations on ${absence} inventories`, () =>
        Effect.gen(function*() {
          const stores = yield* openStores(yield* pathFor)
          const entries = [
            identity("sec-cc"),
            ...Array.from({ length: 7 }, (_, index) => identity(`worker-${String(index)}`))
          ]
          yield* read(stores, entries)
          if (absence === "offline") {
            const result = yield* read(stores, [], 1, "atlas", false, false).pipe(Effect.result)
            expect(Result.isFailure(result)).toBe(true)
          } else yield* read(stores, [], absence === "equal-time" ? 0 : 1, "atlas", absence === "equal-time")
          const next = yield* read(stores, [identity("skills")], 2, "atlas", false)
          // skills and sec-cc are both beans: a retained rose forces the next safe family, ember.
          expect(next.agents[0]).toHaveProperty("hue", "ember")
        }).pipe(Effect.scoped))
    }

    it.effect("normalizes host casing before overflow shape and hue seeds", () =>
      Effect.gen(function*() {
        const stores = yield* openStores(yield* pathFor)
        const first = Array.from(
          { length: 9 },
          (_, index) => ({ id: `agent-${String(index)}`, name: `worker-${String(index)}` })
        )
        yield* read(stores, first.slice(0, 8))
        yield* read(stores, first, 1)
        yield* read(stores, first, 2, "ATLAS")
        const next = yield* read(stores, [...first, { id: "agent-10", name: "worker-10" }], 3, "ATLAS")
        // atlas:agent-10 is squircle, so rose's star and pear holders allow this repeat.
        expect(next.agents.find(({ id }) => id === "agent-10")).toHaveProperty("hue", "rose")
      }).pipe(Effect.scoped))

    for (const owner of Schema.Literals(["local directory", "shared archive"]).literals) {
      it.effect(`rejects stale first sightings after a newer empty ${owner} observation`, () =>
        Effect.gen(function*() {
          const stores = yield* openStores(yield* pathFor)
          if (owner === "local directory") yield* read(stores, [], 100)
          else yield* stores.archive.observe({ host: "atlas", agents: [], observedAt: 100, complete: true })
          const stale = yield* read(stores, [identity("sec-cc")], 50)
          expect(stale.agents[0]).not.toHaveProperty("hue")
          const current = yield* read(
            stores,
            Array.from({ length: 8 }, (_, index) => identity(`worker-${String(index)}`)),
            101
          )
          expect(new Set(current.agents.map(hueOf)).size).toBe(8)
        }).pipe(Effect.scoped))
    }

    it.effect("keeps its allocation after restart, renaming and host case changes", () =>
      Effect.gen(function*() {
        const path = yield* pathFor
        const before = yield* Effect.scoped(Effect.gen(function*() {
          const stores = yield* openStores(path)
          return yield* read(stores, [identity("skills"), identity("sec-cc")])
        }))
        const stores = yield* openStores(path)
        const after = yield* read(
          stores,
          [{ id: "agent-skills", name: "renamed-worker" }, identity("sec-cc")],
          1,
          "ATLAS"
        )
        expect(after.agents.map(hueOf)).toEqual(before.agents.map(hueOf))
      }).pipe(Effect.scoped))

    it.effect("reuses the oldest archived-only family while keeping archived snapshots", () =>
      Effect.gen(function*() {
        const stores = yield* openStores(yield* pathFor)
        const initial = (yield* read(
          stores,
          Array.from({ length: 8 }, (_, index) => identity(`worker-${String(index)}`))
        )).agents
        yield* stores.archive.observe({ host: "atlas", agents: initial, observedAt: 0, complete: true })
        for (let index = 0; index < 8; index++) {
          const agents = initial.slice(index + 1)
          const start = index * 300_002 + 1
          yield* stores.archive.observe({ host: "atlas", agents, observedAt: start, complete: true })
          yield* stores.archive.observe({ host: "atlas", agents, observedAt: start + 300_001, complete: true })
        }
        const archived = yield* stores.archive.page()
        expect(archived.agents).toHaveLength(8)
        const oldest = archived.agents.at(-1)
        expect(oldest).toHaveProperty("hue", hueOf(initial[0]))
        const next = yield* read(stores, [identity("new-worker")], 3_000_000)
        expect(next.agents[0]).toHaveProperty("hue", hueOf(oldest))
        expect((yield* stores.archive.page()).agents).toEqual(archived.agents)
      }).pipe(Effect.scoped))

    it.effect("keeps the returning identity's family when it is free", () =>
      Effect.gen(function*() {
        const stores = yield* openStores(yield* pathFor)
        const first = yield* read(stores, [identity("sec-cc")])
        yield* close(stores, first.agents)
        expect((yield* stores.archive.page()).agents[0]).toHaveProperty("hue", "rose")
        const returned = yield* read(stores, [identity("sec-cc")], 300_002)
        expect(returned.agents[0]).toHaveProperty("hue", "rose")
        yield* stores.archive.observe({ host: "atlas", agents: returned.agents, observedAt: 300_002, complete: true })
        expect((yield* stores.archive.page()).agents).toEqual([])
      }).pipe(Effect.scoped))

    it.effect("reallocates a returning identity when another live agent took its family", () =>
      Effect.gen(function*() {
        const stores = yield* openStores(yield* pathFor)
        const first = yield* read(stores, [
          identity("sec-cc"),
          ...Array.from({ length: 7 }, (_, index) => identity(`worker-${String(index)}`))
        ])
        yield* close(stores, first.agents)
        const taken = yield* read(stores, [identity("skills")], 300_002)
        expect(taken.agents[0]).toHaveProperty("hue", "rose")
        expect((yield* stores.archive.page()).agents[0]).toHaveProperty("hue", "rose")
        const returned = yield* read(stores, [identity("sec-cc"), identity("skills")], 300_003)
        expect(returned.agents).toEqual(expect.arrayContaining([
          expect.objectContaining({ name: "sec-cc", hue: "ember" }),
          expect.objectContaining({ name: "skills", hue: "rose" })
        ]))
      }).pipe(Effect.scoped))

    it.effect("uses a different shape for a repeated family above eight live agents", () =>
      Effect.gen(function*() {
        const stores = yield* openStores(yield* pathFor)
        const first = Array.from(
          { length: 8 },
          (_, index) => ({ id: `agent-${String(index)}`, name: `worker-${String(index)}` })
        )
        yield* read(stores, first)
        const ninth = { id: "agent-8", name: "worker-8" }
        const all = (yield* read(stores, [...first, ninth], 1)).agents
        const bodyById = new Map([
          ["agent-0", "star"],
          ["agent-1", "bean"],
          ["agent-2", "squircle"],
          ["agent-3", "star"],
          ["agent-4", "pear"],
          ["agent-5", "squircle"],
          ["agent-6", "star"],
          ["agent-7", "circle"],
          ["agent-8", "pear"]
        ])
        expect(new Set(all.map(hueOf)).size).toBe(8)
        const added = all.find(({ id }) => id === ninth.id)
        expect(added).toHaveProperty("hue", "rose")
        const repeated = all.filter((row) => row.id !== ninth.id && hueOf(row) === hueOf(added))
        expect(repeated.length).toBeGreaterThan(0)
        for (const row of repeated) expect(bodyById.get(row.id)).not.toBe(bodyById.get(ninth.id))
      }).pipe(Effect.scoped))

    it.effect("falls back only when every family already holds the new shape, reachable at nine", () =>
      Effect.gen(function*() {
        const stores = yield* openStores(yield* pathFor)
        // Golden circle seeds from the drawing's independent host:id shape hash.
        const ids = [7, 18, 29, 33, 44, 45, 56, 66, 67]
        const entries = ids.map((id) => ({ id: `agent-${String(id)}`, name: `agent-${String(id)}` }))
        const first = yield* read(stores, entries.slice(0, 8))
        expect(new Set(first.agents.map(hueOf)).size).toBe(8)
        const all = yield* read(stores, entries, 1)
        expect(all.agents.find(({ id }) => id === "agent-67")).toHaveProperty("hue", "teal")
      }).pipe(Effect.scoped))

    it.effect("does not restart a closed lifetime from an older positive directory sighting", () =>
      Effect.gen(function*() {
        const stores = yield* openStores(yield* pathFor)
        const first = yield* read(stores, [identity("sec-cc")])
        yield* close(stores, first.agents)
        yield* read(stores, [identity("skills")], 300_002)
        const stale = yield* read(stores, [identity("sec-cc")], 1)
        expect(stale.agents[0]).toHaveProperty("hue", "rose")
      }).pipe(Effect.scoped))

    it.effect("does not release a newer positive sighting through an older closure observation", () =>
      Effect.gen(function*() {
        const stores = yield* openStores(yield* pathFor)
        const first = yield* read(stores, [identity("sec-cc")])
        yield* stores.archive.observe({ host: "atlas", agents: first.agents, observedAt: 0, complete: true })
        yield* stores.archive.observe({ host: "atlas", agents: [], observedAt: 1, complete: true })
        yield* read(stores, [identity("sec-cc")], 300_002)
        yield* stores.archive.observe({ host: "atlas", agents: [], observedAt: 300_001, complete: true })
        const other = yield* read(stores, [identity("skills")], 300_003)
        expect(other.agents[0]).toHaveProperty("hue", "ember")
      }).pipe(Effect.scoped))

    it.effect("rolls back the whole first-sighting batch when a later allocation write fails", () =>
      Effect.gen(function*() {
        const stores = yield* openStores(yield* pathFor)
        const database = yield* Effect.acquireRelease(
          Effect.sync(() => new DatabaseSync(stores.activity.path)),
          (opened) => Effect.sync(() => opened.close())
        )
        database.exec(`CREATE TRIGGER hue_failure BEFORE INSERT ON connect_agent_hues
          WHEN NEW.agent_id = 'agent-skills' BEGIN SELECT RAISE(ABORT, 'write refused'); END`)
        const result = yield* read(stores, [identity("sec-cc"), identity("skills")])
        expect(result.agents).toHaveLength(2)
        for (const agent of result.agents) expect(agent).not.toHaveProperty("hue")
        database.exec("DROP TRIGGER hue_failure")
        const next = yield* read(stores, [identity("skills")], 1)
        expect(next.agents[0]).toHaveProperty("hue", "rose")
      }).pipe(Effect.scoped))

    it.effect("serializes simultaneous first sightings across two connections to the same store", () =>
      Effect.gen(function*() {
        const path = yield* pathFor
        const first = yield* openStores(path)
        const second = yield* openStores(path)
        const results = yield* Effect.all([
          read(first, [identity("sec-cc")]),
          read(second, [identity("skills")])
        ], { concurrency: "unbounded" })
        expect(new Set(results.flatMap(({ agents }) => agents.map(hueOf))).size).toBe(2)
      }).pipe(Effect.scoped))
  })

  it("accepts older hue-free rows but rejects the chef family and unknown served families", () => {
    const row = {
      id: "agent-one",
      host: "atlas",
      name: "worker",
      kind: "codex",
      work: "project",
      state: "working",
      lastActivityAt: 0
    }
    expect(Schema.decodeUnknownSync(ConnectAgent)(row)).toEqual(row)
    for (const hue of ["plum", "unknown"]) {
      expect(Result.isFailure(Schema.decodeUnknownResult(ConnectAgent)({ ...row, hue }))).toBe(true)
    }
  })
})
