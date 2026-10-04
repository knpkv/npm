import { NodeServices } from "@effect/platform-node"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Fiber, FileSystem, Layer, Path, Queue, Stream, SubscriptionRef } from "effect"
import { TestClock } from "effect/testing"
import { CredentialsMissing } from "../src/core/ClaudeLimits.js"
import { StoreError, UsageStore } from "../src/core/Store.js"
import { backgroundLayer, claudePollCycle, ingestCycle, RuntimeState } from "../src/server/Runtime.js"

const Services = Layer.mergeAll(
  UsageStore.layer.pipe(Layer.provide(SqliteClient.layer({ filename: ":memory:" }))),
  RuntimeState.layer("host-a")
).pipe(Layer.provideMerge(NodeServices.layer))

describe("background work", () => {
  it.layer(Services)((it) => {
    it.effect("keeps ingesting on schedule while a ticket lookup hangs", () =>
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const root = yield* fs.makeTempDirectoryScoped()
        const state = yield* RuntimeState
        const store = yield* UsageStore
        // A ticket-booked request, so the title refresh really calls the (hanging) search.
        yield* store.commitChunk({
          agent: "claude",
          fileKey: "seed.jsonl",
          cursor: { identity: "0:0", offset: 0, state: "{}" },
          events: [{
            agent: "claude",
            dedupeKey: "seed",
            machine: "host-a",
            sessionId: "s",
            occurredAt: 0,
            model: "claude-opus-5",
            fast: false,
            tokens: { input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
            attribution: { cwd: "/w/app", branch: "feat/RPS-1", activeTicket: null }
          }],
          snapshots: [],
          balances: []
        })
        const build = Layer.build(backgroundLayer({
          roots: {
            claudeProjects: path.join(root, "projects"),
            codexHome: path.join(root, "codex"),
            claudeLimitSamples: path.join(root, "claude-limits.jsonl"),
            machine: "host-a"
          },
          claude: { readToken: Effect.never, get: () => Effect.never },
          ticketSearch: () => Effect.never
        }))
        // Each finished pass, in order, as the status records it: the natural completion signal.
        const passes = yield* Queue.unbounded<number>()
        yield* SubscriptionRef.changes(state.status).pipe(
          Stream.map((status) => status.ingest?.finishedAt ?? null),
          Stream.filter((finishedAt) => finishedAt !== null),
          Stream.changes,
          Stream.runForEach((finishedAt) => Queue.offer(passes, finishedAt)),
          Effect.forkScoped
        )
        yield* build
        const first = yield* Queue.take(passes)
        yield* TestClock.adjust("61 seconds")
        const second = yield* Queue.take(passes)
        expect(second).toBeGreaterThan(first)
      }))
  })

  it.layer(Services)((it) => {
    it.effect("reports a Claude poll that could not be stored apart from ingest, until one is stored", () =>
      Effect.gen(function*() {
        const state = yield* RuntimeState
        const store = yield* UsageStore
        const failing = UsageStore.of({
          ...store,
          recordObservations: () =>
            Effect.fail(new StoreError({ operation: "record-observations", cause: "disk full" }))
        })
        const options = {
          roots: {
            claudeProjects: "/nonexistent/projects",
            codexHome: "/nonexistent/codex",
            claudeLimitSamples: "/nonexistent/claude-limits.jsonl",
            machine: "host-a"
          },
          claude: { readToken: Effect.fail(new CredentialsMissing({ where: "file" })), get: () => Effect.never },
          ticketSearch: () => Effect.never
        }
        yield* claudePollCycle(options).pipe(Effect.provideService(UsageStore, failing))
        yield* ingestCycle(options)
        expect((yield* SubscriptionRef.get(state.status)).limitsFailure).toBe(
          "record-observations: Claude limits could not be stored"
        )
        yield* claudePollCycle(options)
        expect((yield* SubscriptionRef.get(state.status)).limitsFailure).toBeNull()
      }))
  })
})

describe("live versions", () => {
  it.layer(Services)((it) => {
    it.effect("move only after a pass or poll has been stored, and only for what it could change", () =>
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const root = yield* fs.makeTempDirectoryScoped()
        const state = yield* RuntimeState
        const store = yield* UsageStore
        const options = {
          roots: {
            claudeProjects: path.join(root, "projects"),
            codexHome: path.join(root, "codex"),
            claudeLimitSamples: path.join(root, "claude-limits.jsonl"),
            machine: "host-a"
          },
          claude: { readToken: Effect.fail(new CredentialsMissing({ where: "file" })), get: () => Effect.never },
          ticketSearch: () => Effect.never
        }
        const start = yield* SubscriptionRef.get(state.versions)

        // Nothing to read: the status moved, the data did not.
        yield* ingestCycle(options)
        const idle = yield* SubscriptionRef.get(state.versions)
        expect(idle.usage).toBe(start.usage)
        expect(idle.status).toBeGreaterThan(start.status)

        // A sample read: the pass is committed before anyone is told.
        yield* fs.writeFileString(
          options.roots.claudeLimitSamples,
          `${
            JSON.stringify({
              v: 1,
              observedAt: 1_000,
              machine: "h",
              window: "five_hour",
              usedPercentage: 5,
              resetsAt: null
            })
          }\n`
        )
        const seen = yield* SubscriptionRef.changes(state.versions).pipe(
          Stream.filter((versions) => versions.limits > idle.limits),
          Stream.take(1),
          Stream.mapEffect(() => store.limitSnapshots({ from: 0, to: 10_000, machine: "host-a" })),
          Stream.runCollect,
          Effect.forkScoped
        )
        yield* ingestCycle(options)
        const [committed] = yield* Fiber.join(seen)
        expect(committed).toHaveLength(1)

        // A poll stored, even a failed one, is a limits change.
        const beforePoll = yield* SubscriptionRef.get(state.versions)
        yield* claudePollCycle(options)
        expect((yield* SubscriptionRef.get(state.versions)).limits).toBe(beforePoll.limits + 1)
      }))
  })
})
