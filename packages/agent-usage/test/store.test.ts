import { SqliteClient } from "@effect/sql-sqlite-node"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Option, Schema } from "effect"
import { SqlClient } from "effect/sql"
import type { BalanceReading, LimitSnapshot, UsageEvent } from "../src/core/Model.js"
import { buildLimitsReport, buildUsageReport } from "../src/core/Report.js"
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

    it.effect("reads a limit series back as its changes", () =>
      Effect.gen(function*() {
        const store = yield* UsageStore
        yield* store.recordObservations([snapshot(1_000, 10), snapshot(2_000, 10), snapshot(3_000, 12)], [])
        const series = yield* store.limitSnapshots({ from: 0, to: 10_000, machine: "ser8" })
        expect(series.map((row) => row.observedAt)).toEqual([1_000, 3_000])
      }))

    it.effect("keeps every transition when a series arrives interleaved across files", () =>
      Effect.gen(function*() {
        const store = yield* UsageStore
        const at = (observedAt: number, usedPercent: number): LimitSnapshot => ({
          ...snapshot(observedAt, usedPercent),
          label: "interleaved"
        })
        yield* store.recordObservations([at(20_000, 20)], [])
        yield* store.recordObservations([at(10_000, 10), at(30_000, 10)], [])
        const series = (yield* store.limitSnapshots({ from: 0, to: 40_000, machine: "ser8" }))
          .filter((row) => row.label === "interleaved")
        expect(series.map((row) => row.observedAt)).toEqual([10_000, 20_000, 30_000])
      }))

    it.effect("finds a change that arrives late, inside a run of equal readings", () =>
      Effect.gen(function*() {
        const store = yield* UsageStore
        const at = (observedAt: number, usedPercent: number): LimitSnapshot => ({
          ...snapshot(observedAt, usedPercent),
          label: "split"
        })
        yield* store.recordObservations([at(1_000, 10), at(3_000, 10), at(5_000, 10)], [])
        yield* store.recordObservations([at(2_000, 20)], [])
        const series = (yield* store.limitSnapshots({ from: 0, to: 10_000, machine: "ser8" })).filter((row) =>
          row.label === "split"
        )
        // The change back to 10% is where it was next observed (t=3000); t=5000 is the last read.
        expect(series.map((row) => [row.observedAt, row.reading._tag === "Known" ? row.reading.usedPercent : null]))
          .toEqual([[1_000, 10], [2_000, 20], [3_000, 10], [5_000, 10]])
        const balance = (observedAt: number, credits: number): BalanceReading => ({
          kind: "codex-credits",
          machine: "split",
          observedAt,
          value: { _tag: "Known", balance: { _tag: "Credits", credits } }
        })
        yield* store.recordObservations([], [balance(1_000, 50), balance(3_000, 50)])
        yield* store.recordObservations([], [balance(2_000, 40)])
        expect(yield* store.latestBalances("split")).toEqual([
          balance(3_000, 50)
        ])
      }))

    it.effect("keeps every Claude poll, so a recovery after a failed poll is visible", () =>
      Effect.gen(function*() {
        const store = yield* UsageStore
        const claude = (label: string, observedAt: number, reading: LimitSnapshot["reading"]): LimitSnapshot => ({
          agent: "claude",
          machine: "mac",
          source: "claude-oauth-usage",
          label,
          windowMinutes: label === "five_hour" ? 300 : null,
          observedAt,
          reading
        })
        const known: LimitSnapshot["reading"] = { _tag: "Known", usedPercent: 40, resetsAt: null }
        yield* store.recordObservations([
          claude("five_hour", 100_000, known),
          claude("*", 200_000, { _tag: "Unknown", reason: "Fetch" }),
          claude("five_hour", 300_000, known),
          claude("five_hour", 400_000, known)
        ], [])
        const fiveHour = (yield* store.limitSnapshots({ from: 0, to: 500_000, machine: "mac" }))
          .filter((row) => row.label === "five_hour")
        expect(fiveHour.map((row) => row.observedAt)).toEqual([100_000, 300_000, 400_000])
      }))

    it.effect("keeps two outages apart when a recovery came between them", () =>
      Effect.gen(function*() {
        const store = yield* UsageStore
        const claude = (label: string, observedAt: number, reading: LimitSnapshot["reading"]): LimitSnapshot => ({
          agent: "claude",
          machine: "outages",
          source: "claude-oauth-usage",
          label,
          windowMinutes: label === "five_hour" ? 300 : null,
          observedAt,
          reading
        })
        const known: LimitSnapshot["reading"] = { _tag: "Known", usedPercent: 40, resetsAt: null }
        const failed: LimitSnapshot["reading"] = { _tag: "Unknown", reason: "Fetch" }
        yield* store.recordObservations([
          claude("five_hour", 10, known),
          claude("five_hour", 15, known),
          claude("*", 20, failed),
          claude("five_hour", 30, known),
          claude("*", 40, failed),
          claude("*", 45, failed),
          claude("five_hour", 50, known)
        ], [])
        const stored = yield* store.limitSnapshots({ from: 0, to: 100, machine: "outages" })
        const report = buildLimitsReport(stored, { from: 0, to: 100 })
        expect(report.series.find((series) => series.label === "five_hour")?.points.map((point) => point.reading._tag))
          .toEqual(["Known", "Unknown", "Known", "Unknown", "Known"])
        // Equal readings compress (15 joins 10, 45 joins 40) unless the other kind came between;
        // each series' last row is kept for "read … ago".
        expect(stored.filter((row) => row.label === "*").map((row) => row.observedAt)).toEqual([20, 40, 45])
        expect(stored.filter((row) => row.label === "five_hour").map((row) => row.observedAt)).toEqual([10, 30, 50])
      }))

    it.effect("prices a bucket's requests without cache writes even when those with them have no rate", () =>
      Effect.gen(function*() {
        const store = yield* UsageStore
        const at = Date.parse("2026-09-03T10:01:00.000Z")
        const plain = { input: 1_000, output: 100, reasoning: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }
        yield* store.commitChunk({
          agent: "codex",
          fileKey: "mixed.jsonl",
          cursor,
          events: [
            event("mixed-1", { agent: "codex", model: "gpt-5.5", machine: "mixed", occurredAt: at, tokens: plain }),
            event("mixed-2", {
              agent: "codex",
              model: "gpt-5.5",
              machine: "mixed",
              occurredAt: at + 1_000,
              tokens: { ...plain, cacheWrite5m: 1 }
            })
          ],
          snapshots: [],
          balances: []
        })
        const groups = yield* store.usageGroups({ from: at - 60_000, to: at + 60_000, machine: "mixed" })
        const report = buildUsageReport(groups, [{ key: "day", start: at - 60_000 }], {}, new Set())
        expect(report.bookings[0]?.costUsd).toBeCloseTo(0.008, 6)
        expect(report.unpriced.tokens).toBe(1_101)
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
        const series = (yield* store.limitSnapshots({ from: 4_000, to: 6_000, machine: "ser8" })).filter((row) =>
          row.agent === "claude"
        )
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
        const ours = store.latestBalances("ser8")
        expect(yield* ours).toEqual([reading(3, 40)])
        yield* store.recordObservations([], [reading(4, 40)])
        // The newest observation is the latest reading, so "read … ago" stays true.
        expect(yield* ours).toEqual([reading(4, 40)])
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
          machine: "ser8",
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
    it.effect("reads only the Machine it is asked for", () =>
      Effect.gen(function*() {
        const store = yield* UsageStore
        yield* store.commitChunk({
          agent: "claude",
          fileKey: "machines.jsonl",
          cursor,
          events: [
            event("on-a-1", { machine: "a", occurredAt: 1_000 }),
            event("on-a-2", { machine: "a", occurredAt: 2_000 }),
            event("on-b", {
              machine: "b",
              occurredAt: 1_500,
              attribution: { cwd: "/w/b", branch: "feat/OPS-1", activeTicket: null }
            })
          ],
          snapshots: [{ ...snapshot(1_000, 10), machine: "b" }],
          balances: [{
            kind: "codex-credits",
            machine: "b",
            observedAt: 1_000,
            value: { _tag: "Known", balance: { _tag: "Credits", credits: 1 } }
          }]
        })
        const groups = yield* store.usageGroups({ from: 0, to: 10_000, machine: "a" })
        expect(groups.reduce((sum, group) => sum + group.requests, 0)).toBe(2)
        expect((yield* store.places("a")).map((place) => place.branch)).toEqual(["feat/RPS-1"])
        expect(yield* store.limitSnapshots({ from: 0, to: 10_000, machine: "a" })).toEqual([])
        expect(yield* store.latestBalances("a")).toEqual([])
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
