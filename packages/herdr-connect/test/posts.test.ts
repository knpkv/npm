import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Effect, FileSystem, Path, Result, Schema } from "effect"
import { DatabaseSync } from "node:sqlite"
import { AgentArchiveStore } from "../src/archive-store.js"
import { AgentPostStore } from "../src/post-store.js"
import {
  ConnectLastWords,
  ConnectPost,
  ConnectPostBody,
  ConnectPostRequest,
  connectPostTextLimit
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
