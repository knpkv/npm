import { SqliteClient } from "@effect/sql-sqlite-node"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Option, Schema } from "effect"
import { SqlClient } from "effect/sql"
import type { BalanceReading, LimitSnapshot, UsageEvent } from "../src/core/Model.js"
import { type Chunk, UsageStore } from "../src/core/Store.js"

const TestStore = UsageStore.layer.pipe(Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })))

const event = (dedupeKey: string, overrides: Partial<UsageEvent> = {}): UsageEvent => ({
  agent: "claude",
  dedupeKey,
  machine: "ser8",
  sessionId: "s-1",
  occurredAt: Date.parse("2026-09-01T10:07:00.000Z"),
  model: "claude-opus-5",
  fast: false,
  tokens: { input: 10, output: 20, reasoning: 0, cacheRead: 5, cacheWrite5m: 1, cacheWrite1h: 0 },
  attribution: { cwd: "/w/app", branch: "feat/RPS-1", activeTicket: null },
  ...overrides
})

const snapshot = (observedAt: number, usedPercent: number): LimitSnapshot => ({
  agent: "codex",
  machine: "ser8",
  source: "codex-rollout",
  label: "secondary",
  windowMinutes: 10080,
  observedAt,
  reading: { _tag: "Known", usedPercent, resetsAt: 1_790_000_000_000 }
})

const cursor = { identity: "1:42", offset: 120, state: "{\"activeTicket\":null}" }

describe("UsageStore", () => {
  it.layer(TestStore)((it) => {
    it.effect("commits a chunk's events and its cursor together, and a re-read adds nothing", () =>
      Effect.gen(function*() {
        const store = yield* UsageStore
        const chunk: Chunk = {
          agent: "claude",
          fileKey: "proj/a.jsonl",
          cursor,
          events: [event("m1"), event("m2")],
          snapshots: [],
          balances: []
        }
        expect((yield* store.commitChunk(chunk)).eventsAdded).toBe(2)
        expect((yield* store.commitChunk(chunk)).eventsAdded).toBe(0)
        expect(yield* store.cursor("claude", "proj/a.jsonl")).toEqual(Option.some(cursor))
        expect(yield* store.cursor("codex", "proj/a.jsonl")).toEqual(Option.none())
      }))

    it.effect("stores a limit series only when its reading changes", () =>
      Effect.gen(function*() {
        const store = yield* UsageStore
        yield* store.recordObservations([snapshot(1_000, 10), snapshot(2_000, 10), snapshot(3_000, 12)], [])
        const series = yield* store.limitSnapshots({ from: 0, to: 10_000 })
        expect(series.map((row) => row.observedAt)).toEqual([1_000, 3_000])
      }))

    it.effect("stores Unknown limit readings so a gap stays visible", () =>
      Effect.gen(function*() {
        const store = yield* UsageStore
        const unknown: LimitSnapshot = {
          agent: "claude",
          machine: "ser8",
          source: "claude-oauth-usage",
          label: "*",
          windowMinutes: null,
          observedAt: 5_000,
          reading: { _tag: "Unknown", reason: "AuthExpired" }
        }
        yield* store.recordObservations([unknown], [])
        const series = yield* store.limitSnapshots({ from: 4_000, to: 6_000 })
        expect(series).toEqual([unknown])
      }))

    it.effect("keeps the latest balance per kind, storing only changes", () =>
      Effect.gen(function*() {
        const store = yield* UsageStore
        const reading = (observedAt: number, credits: number): BalanceReading => ({
          kind: "codex-credits",
          machine: "ser8",
          observedAt,
          value: { _tag: "Known", balance: { _tag: "Credits", credits } }
        })
        yield* store.recordObservations([], [reading(1, 50), reading(2, 50), reading(3, 40)])
        expect(yield* store.latestBalances).toEqual([reading(3, 40)])
      }))

    it.effect("pre-aggregates usage into 15-minute buckets by pricing and attribution dimensions", () =>
      Effect.gen(function*() {
        const store = yield* UsageStore
        yield* store.commitChunk({
          agent: "codex",
          fileKey: "2026/09/01/r.jsonl",
          cursor,
          events: [
            event("c1", { agent: "codex", model: "gpt-6-sol", occurredAt: Date.parse("2026-09-01T10:01:00.000Z") }),
            event("c2", { agent: "codex", model: "gpt-6-sol", occurredAt: Date.parse("2026-09-01T10:14:00.000Z") }),
            event("c3", { agent: "codex", model: "gpt-6-sol", occurredAt: Date.parse("2026-09-01T10:16:00.000Z") })
          ],
          snapshots: [],
          balances: []
        })
        const groups = yield* store.usageGroups({
          from: Date.parse("2026-09-01T10:00:00.000Z"),
          to: Date.parse("2026-09-01T11:00:00.000Z")
        })
        const codex = groups.filter((group) => group.agent === "codex")
        expect(codex.map((group) => [group.bucketStart, group.requests, group.tokens.input])).toEqual([
          [Date.parse("2026-09-01T10:00:00.000Z"), 2, 20],
          [Date.parse("2026-09-01T10:15:00.000Z"), 1, 10]
        ])
        expect(codex[0]?.attribution).toEqual({ cwd: "/w/app", branch: "feat/RPS-1", activeTicket: null })
        expect(codex[0]?.longPrompt).toBe(false)
      }))
  })

  it.layer(TestStore)((it) => {
    it.effect("persists counts and attribution metadata only: no column can hold prompt or response text", () =>
      Effect.gen(function*() {
        yield* UsageStore
        const sql = yield* SqlClient.SqlClient
        const tables = yield* sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'effect_%'`
          .pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ name: Schema.String }))))
          )
        const columns: Record<string, ReadonlyArray<string>> = {}
        for (const { name } of tables) {
          const info = yield* sql`SELECT name FROM pragma_table_info(${name})`.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ name: Schema.String }))))
          )
          columns[name] = info.map((column) => column.name)
        }
        expect(columns).toEqual({
          usage_events: [
            "agent",
            "dedupe_key",
            "machine",
            "session_id",
            "occurred_at",
            "model",
            "fast",
            "input",
            "output",
            "reasoning",
            "cache_read",
            "cache_write_5m",
            "cache_write_1h",
            "cwd",
            "branch",
            "active_ticket"
          ],
          ingest_cursors: ["agent", "file_key", "identity", "offset", "state"],
          limit_snapshots: [
            "agent",
            "machine",
            "source",
            "label",
            "window_minutes",
            "observed_at",
            "reading"
          ],
          balance_readings: ["kind", "machine", "observed_at", "value"],
          tickets: ["key", "summary", "fetched_at"]
        })
      }))
  })
})
