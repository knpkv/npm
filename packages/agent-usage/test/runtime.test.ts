import { NodeServices } from "@effect/platform-node"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { describe, expect, it } from "@effect/vitest"
import { Effect, FileSystem, Layer, Path, Ref } from "effect"
import { TestClock } from "effect/testing"
import { UsageStore } from "../src/core/Store.js"
import { backgroundLayer, RuntimeState } from "../src/server/Runtime.js"

const Services = Layer.mergeAll(
  UsageStore.layer.pipe(Layer.provide(SqliteClient.layer({ filename: ":memory:" }))),
  RuntimeState.layer("ser8")
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
            machine: "ser8",
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
        yield* Layer.build(backgroundLayer({
          roots: { claudeProjects: path.join(root, "projects"), codexHome: path.join(root, "codex"), machine: "ser8" },
          claude: { readToken: Effect.never, get: () => Effect.never },
          ticketSearch: () => Effect.never
        }))
        /** Waits, without moving the test clock, for a pass that finished after `after`. */
        const passAfter = (after: number) =>
          Effect.yieldNow.pipe(
            Effect.andThen(Ref.get(state.status)),
            Effect.map((status) => status.ingest?.finishedAt),
            Effect.repeat({ until: (finished) => finished !== undefined && finished > after, times: 10_000 })
          )
        const first = yield* passAfter(-1)
        yield* TestClock.adjust("61 seconds")
        const second = yield* passAfter(first ?? 0)
        expect(first).toBeDefined()
        expect(second).toBeDefined()
        expect(second).toBeGreaterThan(first ?? Number.POSITIVE_INFINITY)
      }))
  })
})
