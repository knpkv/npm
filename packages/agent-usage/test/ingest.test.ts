import { NodeServices } from "@effect/platform-node"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { describe, expect, it } from "@effect/vitest"
import { Effect, FileSystem, Layer, Path } from "effect"
import { ingestOnce, type SourceRoots } from "../src/core/Ingest.js"
import { UsageStore } from "../src/core/Store.js"
import { claudeAssistant, claudeUser, codexMeta, codexTokenCount, codexTurn } from "./fixtures.js"

const TestLayer = UsageStore.layer.pipe(
  Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })),
  Layer.provideMerge(NodeServices.layer)
)

const jsonl = (...values: ReadonlyArray<object>): string => values.map((value) => `${JSON.stringify(value)}\n`).join("")

const setup = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const root = yield* fs.makeTempDirectoryScoped()
  const roots: SourceRoots = {
    claudeProjects: path.join(root, "claude", "projects"),
    codexHome: path.join(root, "codex"),
    machine: "ser8"
  }
  yield* fs.makeDirectory(path.join(roots.claudeProjects, "-w-app", "sess-1", "subagents"), { recursive: true })
  yield* fs.makeDirectory(path.join(roots.codexHome, "sessions", "2026", "09", "01"), { recursive: true })
  return { fs, path, roots }
})

const totalRequests = Effect.gen(function*() {
  const store = yield* UsageStore
  const groups = yield* store.usageGroups({ from: 0, to: Number.MAX_SAFE_INTEGER, machine: "ser8" })
  return groups.reduce((sum, group) => sum + group.requests, 0)
})

describe("ingestOnce", () => {
  it.layer(TestLayer)((it) => {
    it.effect("reads sessions and subagents once, then only what was appended", () =>
      Effect.gen(function*() {
        const { fs, path, roots } = yield* setup
        const session = path.join(roots.claudeProjects, "-w-app", "sess-1.jsonl")
        yield* fs.writeFileString(
          session,
          jsonl(claudeUser("fix RPS-7071"), claudeAssistant({ id: "a", at: "2026-09-01T10:00:00.000Z" }))
        )
        yield* fs.writeFileString(
          path.join(roots.claudeProjects, "-w-app", "sess-1", "subagents", "agent-x.jsonl"),
          jsonl(claudeAssistant({ id: "sub", at: "2026-09-01T10:00:30.000Z" }))
        )
        const first = yield* ingestOnce(roots)
        expect(first.claude.eventsAdded).toBe(2)
        expect((yield* ingestOnce(roots)).claude.eventsAdded).toBe(0)

        // A line still being written is not consumed until its newline lands.
        const partial = JSON.stringify(claudeAssistant({ id: "b", at: "2026-09-01T10:05:00.000Z" }))
        yield* fs.writeFileString(session, partial.slice(0, 40), { flag: "a" })
        expect((yield* ingestOnce(roots)).claude.eventsAdded).toBe(0)
        yield* fs.writeFileString(session, `${partial.slice(40)}\n`, { flag: "a" })
        expect((yield* ingestOnce(roots)).claude.eventsAdded).toBe(1)
        expect(yield* totalRequests).toBe(3)
      }))
  })

  it.layer(TestLayer)((it) => {
    it.effect("books a rollout appended across passes exactly as one read, keeping state in the cursor", () =>
      Effect.gen(function*() {
        const { fs, path, roots } = yield* setup
        const rollout = path.join(
          roots.codexHome,
          "sessions",
          "2026",
          "09",
          "01",
          "rollout-2026-09-01T10-00-00-22222222-2222-2222-2222-222222222222.jsonl"
        )
        yield* fs.writeFileString(rollout, jsonl(codexMeta("/w/svc", "feat/RPS-12"), codexTurn("gpt-6-sol")))
        yield* ingestOnce(roots)
        yield* fs.writeFileString(
          rollout,
          jsonl(
            codexTokenCount({ at: "2026-09-01T10:00:05.000Z", last: [100, 0, 30, 0], total: 130 }),
            codexTokenCount({ at: "2026-09-01T10:00:06.000Z", last: [100, 0, 30, 0], total: 130 })
          ),
          { flag: "a" }
        )
        const status = yield* ingestOnce(roots, { chunkBytes: 64 })
        expect(status.codex.eventsAdded).toBe(1)
        const store = yield* UsageStore
        const groups = yield* store.usageGroups({ from: 0, to: Number.MAX_SAFE_INTEGER, machine: "ser8" })
        expect(groups[0]).toMatchObject({
          model: "gpt-6-sol",
          attribution: { cwd: "/w/svc", branch: "feat/RPS-12", activeTicket: null }
        })
      }))
  })

  it.layer(TestLayer)((it) => {
    it.effect("re-reads a replaced file from the start without double-counting", () =>
      Effect.gen(function*() {
        const { fs, path, roots } = yield* setup
        const session = path.join(roots.claudeProjects, "-w-app", "sess-1.jsonl")
        const content = jsonl(claudeAssistant({ id: "a", at: "2026-09-01T10:00:00.000Z" }))
        yield* fs.writeFileString(session, content)
        yield* ingestOnce(roots)
        yield* fs.remove(session)
        yield* fs.writeFileString(session, content)
        expect((yield* ingestOnce(roots)).claude.eventsAdded).toBe(0)
        expect(yield* totalRequests).toBe(1)
      }))
  })

  it.layer(TestLayer)((it) => {
    it.effect("reports an unreadable file and a missing root instead of passing over them", () =>
      Effect.gen(function*() {
        const { fs, path, roots } = yield* setup
        const session = path.join(roots.claudeProjects, "-w-app", "sess-1.jsonl")
        yield* fs.writeFileString(session, jsonl(claudeAssistant({ id: "a", at: "2026-09-01T10:00:00.000Z" })))
        yield* fs.chmod(session, 0o000)
        yield* fs.remove(roots.codexHome, { recursive: true })
        const status = yield* ingestOnce(roots)
        expect(status.claude.unreadable).toEqual([{ fileKey: "-w-app/sess-1.jsonl", reason: "PermissionDenied" }])
        expect(status.codex.rootMissing).toBe(true)
      }))
  })

  it.layer(TestLayer)((it) => {
    it.effect("reads every other project when one project directory belongs to someone else", () =>
      Effect.gen(function*() {
        const { fs, path, roots } = yield* setup
        yield* fs.writeFileString(
          path.join(roots.claudeProjects, "-w-app", "sess-1.jsonl"),
          jsonl(claudeAssistant({ id: "a", at: "2026-09-01T10:00:00.000Z" }))
        )
        const foreign = path.join(roots.claudeProjects, "-usr-src-app")
        yield* fs.makeDirectory(foreign)
        yield* fs.chmod(foreign, 0o000)
        const status = yield* ingestOnce(roots)
        yield* fs.chmod(foreign, 0o700)
        expect(status.claude.eventsAdded).toBe(1)
        expect(status.claude.unreadable).toEqual([{ fileKey: "-usr-src-app", reason: "PermissionDenied" }])
      }))
  })

  it.layer(TestLayer)((it) => {
    it.effect("reads archived rollouts, and a rollout moved to the archive counts once", () =>
      Effect.gen(function*() {
        const { fs, path, roots } = yield* setup
        const name = "rollout-2026-09-01T10-00-00-33333333-3333-3333-3333-333333333333.jsonl"
        const live = path.join(roots.codexHome, "sessions", "2026", "09", "01", name)
        const content = jsonl(
          codexTurn("gpt-6-sol"),
          codexTokenCount({ at: "2026-09-01T10:00:05.000Z", last: [100, 0, 30, 0], total: 130 })
        )
        yield* fs.writeFileString(live, content)
        expect((yield* ingestOnce(roots)).codex.eventsAdded).toBe(1)
        yield* fs.makeDirectory(path.join(roots.codexHome, "archived_sessions"))
        yield* fs.rename(live, path.join(roots.codexHome, "archived_sessions", name))
        const archived = path.join(
          roots.codexHome,
          "archived_sessions",
          "rollout-2026-09-02T10-00-00-44444444-4444-4444-4444-444444444444.jsonl"
        )
        yield* fs.writeFileString(archived, content)
        const status = yield* ingestOnce(roots)
        expect(status.codex.filesScanned).toBe(2)
        expect(status.codex.eventsAdded).toBe(1)
      }))
  })

  it.layer(TestLayer)((it) => {
    it.effect("skips a line too long to hold, once, and reads on past it", () =>
      Effect.gen(function*() {
        const { fs, path, roots } = yield* setup
        const session = path.join(roots.claudeProjects, "-w-app", "sess-1.jsonl")
        yield* fs.writeFileString(
          session,
          `${JSON.stringify(claudeUser("x".repeat(2_000)))}\n` +
            jsonl(claudeAssistant({ id: "after", at: "2026-09-01T10:00:00.000Z" }))
        )
        const first = yield* ingestOnce(roots, { chunkBytes: 64, maxLineBytes: 500 })
        expect(first.claude.eventsAdded).toBe(1)
        expect(first.claude.skipped.oversizedLine).toBe(1)
        const second = yield* ingestOnce(roots, { chunkBytes: 64, maxLineBytes: 500 })
        expect(second.claude.skipped.oversizedLine).toBe(0)
      }))
  })
})
