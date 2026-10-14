import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Fiber, FileSystem, Path, Result, Schema } from "effect"
import { HttpClient } from "effect/http"
import { TestClock } from "effect/testing"
import { DatabaseSync } from "node:sqlite"
import { AgentArchiveStore } from "../src/archive-store.js"
import { fleetConnectAgents } from "../src/directory.js"
import { type ConnectAgent, LocalConnectAgents } from "../src/model.js"
import { AgentPostStore, connectPostRetentionMillis } from "../src/post-store.js"
import {
  ConnectLastWords,
  ConnectPost,
  ConnectPostBody,
  ConnectPostRequest,
  connectPostTextLimit,
  Unavailable
} from "../src/posts.js"

const body: ConnectPostBody = { kind: "status", text: "Tests passing", eventId: "event-one" }
const openStore = Effect.fn("PostTest.open")(function*() {
  const fs = yield* FileSystem.FileSystem
  const paths = yield* Path.Path
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "connect-posts-" })
  return yield* Effect.acquireRelease(
    AgentPostStore.open(paths.join(directory, "posts.sqlite")),
    (store) => Effect.sync(() => store.close())
  )
})

describe("agent posts", () => {
  it("rejects blank writes while preserving historical whitespace and valid text unchanged", () => {
    for (const text of ["", " ", " \t\n "]) {
      const request = { ...body, text, agentId: "agent-one" }
      expect(Schema.is(ConnectPostBody)({ ...body, text })).toBe(false)
      expect(Schema.is(ConnectPostRequest)(request)).toBe(false)
    }
    for (const text of [" ", " \t\n "]) {
      const post = { ...body, text, agentId: "agent-one", host: "host-a", createdAt: 0, sequence: 1 }
      expect(Schema.decodeUnknownSync(ConnectPost)(post).text).toBe(text)
      expect(Schema.decodeUnknownSync(ConnectLastWords)({ text, createdAt: 0 }).text).toBe(text)
    }
    const text = " \thttps://example.test/status\n "
    expect(Schema.decodeUnknownSync(ConnectPostBody)({ ...body, text }).text).toBe(text)
  })

  it("bounds status at 240 characters and other kinds at 1024", () => {
    expect(connectPostTextLimit).toEqual({ status: 240, other: 1024 })
    for (const kind of ["status", "progress", "skill-feedback", "note", "blocker"]) {
      const maximum = kind === "status" ? 240 : 1024
      expect(Schema.is(ConnectPostBody)({ ...body, kind, text: "x".repeat(maximum) })).toBe(true)
      expect(Schema.is(ConnectPostBody)({ ...body, kind, text: "x".repeat(maximum + 1) })).toBe(false)
      const request = { ...body, kind, agentId: "agent-one" }
      const post = { ...request, host: "host-a", createdAt: 0, sequence: 1 }
      expect(Schema.is(ConnectPostRequest)({ ...request, text: "x".repeat(maximum) })).toBe(true)
      expect(Schema.is(ConnectPostRequest)({ ...request, text: "x".repeat(maximum + 1) })).toBe(false)
      expect(Schema.is(ConnectPost)({ ...post, text: "x".repeat(maximum) })).toBe(true)
      expect(Schema.is(ConnectPost)({ ...post, text: "x".repeat(maximum + 1) })).toBe(false)
    }
    for (const invalid of [{ ...body, text: "" }, { ...body, kind: "transcript" }, { ...body, eventId: "" }]) {
      expect(Schema.is(ConnectPostBody)(invalid)).toBe(false)
    }
  })

  it.layer(NodeServices.layer)((it) => {
    it.effect.each([false, true])(
      "bounds queued post and self-state writers from entry; unlock %s",
      (unlock) =>
        Effect.gen(function*() {
          const store = yield* openStore()
          const db = yield* Effect.acquireRelease(
            Effect.sync(() => new DatabaseSync(store.path)),
            (value) => Effect.sync(() => value.close())
          )
          let held = true
          yield* Effect.acquireRelease(Effect.sync(() => db.exec("BEGIN IMMEDIATE")), () =>
            Effect.sync(() => {
              if (held) db.exec("ROLLBACK")
            }))
          const first = yield* Effect.forkScoped(Effect.result(store.post("host-a", "agent-one", body, 1)))
          const second = yield* Effect.forkScoped(
            Effect.result(store.selfUpdate("host-a", "agent-one", { mood: "focused" }, 1))
          )
          yield* TestClock.adjust(1)
          if (unlock) {
            yield* Effect.sync(() => db.exec("ROLLBACK"))
            held = false
          }
          // Let retries resume after unlock without expiring real filesystem completion.
          yield* TestClock.adjust(unlock ? 1_000 : 6_000)
          if (!unlock) {
            expect(first.pollUnsafe()).toBeDefined()
            expect(second.pollUnsafe()).toBeDefined()
          }
          const firstResult = yield* Fiber.join(first)
          const secondResult = yield* Fiber.join(second)
          expect(Result.isSuccess(firstResult)).toBe(unlock)
          expect(Result.isSuccess(secondResult)).toBe(unlock)
          if (!unlock) {
            expect(firstResult).toMatchObject({
              failure: { _tag: "ConnectStoreBusyError", operation: "posts.post", timeoutMillis: 5_000 }
            })
            expect(secondResult).toMatchObject({
              failure: { _tag: "ConnectStoreBusyError", operation: "self.update", timeoutMillis: 5_000 }
            })
          } else {
            expect((yield* store.page("host-a", "agent-one", null, 1)).posts).toHaveLength(1)
            expect(yield* store.selfLatestMany([{ host: "host-a", agentId: "agent-one" }])).toHaveLength(1)
          }
        }).pipe(Effect.scoped)
    )

    it.effect("keeps stored whitespace reports readable in pages, latest reads and archive last words", () =>
      Effect.gen(function*() {
        const store = yield* openStore()
        const archive = yield* Effect.acquireRelease(
          AgentArchiveStore.open(store.path),
          (opened) => Effect.sync(() => opened.close())
        )
        yield* archive.observe({
          host: "HOST-A",
          complete: true,
          observedAt: 0,
          agents: [{
            id: "agent-one",
            host: "HOST-A",
            name: "worker",
            kind: "worker",
            state: "working",
            work: "project",
            lastActivityAt: 0
          }]
        })
        const database = yield* Effect.acquireRelease(
          Effect.sync(() => new DatabaseSync(store.path)),
          (opened) => Effect.sync(() => opened.close())
        )
        const text = " \t\n "
        yield* Effect.sync(() =>
          database.prepare(`INSERT INTO connect_posts
            (host, agent_id, event_id, kind, text, goal_step, created_at)
            VALUES ('host-a', 'agent-one', 'legacy-blank', 'status', ?, NULL, 1)`).run(text)
        )
        const page = yield* store.page("HOST-A", "agent-one", null, 2)
        expect(page.posts).toHaveLength(1)
        expect(page.posts[0]?.text).toBe(text)
        expect((yield* store.latest("HOST-A", "agent-one", 2))?.text).toBe(text)
        yield* archive.observe({ host: "HOST-A", complete: true, agents: [], observedAt: 3 })
        yield* archive.observe({ host: "HOST-A", complete: true, agents: [], observedAt: 300_003 })
        expect((yield* archive.page()).agents[0]).toMatchObject({ lastWords: { text, createdAt: 1 } })
      }).pipe(Effect.scoped))

    it.effect("rejects new whitespace-only posts with the text field detail", () =>
      Effect.gen(function*() {
        const store = yield* openStore()
        for (const text of [" ", " \t\n "]) {
          const result = yield* Effect.result(store.post("HOST-A", "agent-one", { ...body, text }, 1))
          if (Result.isSuccess(result)) return yield* Effect.die("blank write accepted")
          expect(result.failure).toMatchObject({ _tag: "InvalidReport", detail: "text is empty" })
        }
        expect((yield* store.page("HOST-A", "agent-one", null, 2)).posts).toEqual([])
      }).pipe(Effect.scoped))

    it.effect("retries preserve the original post and changed event payloads conflict", () =>
      Effect.gen(function*() {
        const store = yield* openStore()
        const first = yield* store.post("HOST-A", "agent-one", body, 1)
        const fs = yield* FileSystem.FileSystem
        const paths = yield* Path.Path
        if (paths.sep === "/") {
          expect((yield* fs.stat(paths.dirname(store.path))).mode & 0o777).toBe(0o700)
          for (const file of [store.path, `${store.path}-wal`, `${store.path}-shm`]) {
            if (yield* fs.exists(file)) expect((yield* fs.stat(file)).mode & 0o777).toBe(0o600)
          }
        }
        expect(yield* store.post("host-a", "agent-one", body, 2)).toEqual(first)
        const conflict = yield* Effect.result(store.post("host-a", "agent-one", { ...body, text: "Changed" }, 3))
        expect(Result.isFailure(conflict) && conflict.failure._tag).toBe("Conflict")
        expect((yield* store.page("HOST-A", "agent-one", null, 3)).posts).toEqual([first])
      }).pipe(Effect.scoped))

    it.effect("retains the newest 128 posts per host and agent, pages newest first, and expires at 90 days", () =>
      Effect.gen(function*() {
        const store = yield* openStore()
        yield* store.post("HOST-B", "agent-one", body, 0)
        yield* store.post("HOST-A", "agent-two", body, 0)
        for (let index = 0; index < 130; index++) {
          yield* store.post("HOST-A", "agent-one", { ...body, eventId: `event-${index}`, text: `${index}` }, index)
        }
        const first = yield* store.page("host-a", "agent-one", null, 130)
        const second = yield* store.page("host-a", "agent-one", first.nextCursor, 130)
        expect(first.posts).toHaveLength(64)
        expect(second.posts).toHaveLength(64)
        expect(second.nextCursor).toBeNull()
        expect(first.posts[0]?.text).toBe("129")
        expect(second.posts.at(-1)?.text).toBe("2")
        expect(new Set([...first.posts, ...second.posts].map((post) => post.sequence)).size).toBe(128)
        expect((yield* store.latest("host-a", "agent-one", 130))?.text).toBe("129")
        expect((yield* store.page("host-b", "agent-one", null, 130)).posts).toHaveLength(1)
        expect((yield* store.page("host-a", "agent-two", null, 130)).posts).toHaveLength(1)
        expect((yield* store.page("host-a", "agent-one", null, 7_776_000_129)).posts).toHaveLength(1)
        expect(yield* store.latest("host-a", "agent-one", 7_776_000_130)).toBeNull()
      }).pipe(Effect.scoped))

    it.effect("migrates an existing archive without dropping closed agents", () =>
      Effect.gen(function*() {
        const store = yield* openStore()
        const database = yield* Effect.acquireRelease(Effect.sync(() => new DatabaseSync(store.path)), (opened) =>
          Effect.sync(() => opened.close()))
        yield* Effect.sync(() =>
          database.exec(`
          CREATE TABLE connect_agent_archive (
            host TEXT COLLATE NOCASE, agent_id TEXT, name TEXT, kind TEXT, work TEXT, state TEXT,
            first_seen_at INTEGER, closed_at INTEGER, parent_agent_id TEXT, relation TEXT,
            PRIMARY KEY (host, agent_id)
          );
          INSERT INTO connect_agent_archive VALUES ('host-a', 'agent-old', 'worker', 'worker', 'project', 'idle', 0, 1, NULL, NULL);
        `)
        )
        const archive = yield* Effect.acquireRelease(AgentArchiveStore.open(store.path), (opened) =>
          Effect.sync(() =>
            opened.close()
          ))
        expect((yield* archive.page()).agents).toEqual([{
          host: "host-a",
          agentId: "agent-old",
          name: "worker",
          kind: "worker",
          work: "project",
          state: "idle",
          firstSeenAt: 0,
          closedAt: 1
        }])
      }).pipe(Effect.scoped))

    it.effect.each([0, 300_001, 300_002, 300_003])(
      "directory closure filters words at the inclusive retention cutoff; created %s",
      (createdAt) =>
        Effect.gen(function*() {
          const store = yield* openStore()
          const archive = yield* Effect.acquireRelease(AgentArchiveStore.open(store.path), (value) =>
            Effect.sync(() => value.close()))
          const row: ConnectAgent = {
            id: "agent-one",
            host: "HOST-A",
            name: "Worker",
            kind: "worker",
            state: "working",
            work: "project",
            lastActivityAt: 0
          }
          yield* store.post(row.host, row.id, body, createdAt)
          const poll = (agents: ReadonlyArray<ConnectAgent>, observedAt: number) =>
            fleetConnectAgents(
              Effect.succeed(LocalConnectAgents.make({ host: row.host, agents, complete: true })),
              [],
              { store: archive, posts: store, observedAt }
            ).pipe(Effect.provideService(
              HttpClient.HttpClient,
              HttpClient.make(() =>
                Effect.die(new Unavailable({ operation: "fixture.peer" }))
              )
            ))
          const live = yield* poll([row], connectPostRetentionMillis + 1)
          expect(live.agents[0]?.voice === undefined).toBe(createdAt === 0)
          yield* poll([], connectPostRetentionMillis + 2)
          yield* poll([], connectPostRetentionMillis + 300_002)
          const closed = (yield* archive.page()).agents[0]
          expect(closed).toBeDefined()
          if (createdAt < 300_002) {
            expect(closed?.lastWords).toBeUndefined()
          } else expect(closed?.lastWords).toEqual({ text: body.text, createdAt })
        }).pipe(Effect.scoped)
    )

    it.effect("closure snapshots the latest words and retains them after post eviction and reopening", () =>
      Effect.gen(function*() {
        const store = yield* openStore()
        const archive = yield* Effect.acquireRelease(
          AgentArchiveStore.open(store.path),
          (opened) => Effect.sync(() => opened.close())
        )
        yield* archive.observe({
          host: "HOST-A",
          complete: true,
          observedAt: 0,
          agents: [{
            id: "agent-one",
            host: "HOST-A",
            name: "worker",
            kind: "worker",
            state: "working",
            work: "project",
            lastActivityAt: 0
          }]
        })
        yield* store.post("HOST-A", "agent-one", body, 1)
        yield* store.post("HOST-A", "agent-one", { ...body, eventId: "event-two", text: "Finished" }, 2)
        yield* archive.observe({ host: "HOST-A", complete: true, agents: [], observedAt: 3 })
        yield* archive.observe({ host: "HOST-A", complete: true, agents: [], observedAt: 300_003 })
        yield* store.page("HOST-A", "agent-one", null, 8_000_000_000)
        const reopened = yield* Effect.acquireRelease(
          AgentArchiveStore.open(store.path),
          (opened) => Effect.sync(() => opened.close())
        )
        expect((yield* reopened.page()).agents[0]).toMatchObject({ lastWords: { text: "Finished", createdAt: 2 } })
      }).pipe(Effect.scoped))
  })
})
