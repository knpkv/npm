import { SqliteClient } from "@effect/sql-sqlite-node"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { TestClock } from "effect/testing"
import { UsageStore } from "../src/core/Store.js"
import { refreshTicketTitles, searchOutcome, TicketLookupFailed, ticketTitles } from "../src/core/Tickets.js"

const TestStore = UsageStore.layer.pipe(Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })))

const day = 24 * 60 * 60 * 1000

describe("ticket titles", () => {
  it.layer(TestStore)((it) => {
    it.effect("looks up uncached keys once, remembers misses, and serves the cache until a day passes", () =>
      Effect.gen(function*() {
        const searched: Array<ReadonlyArray<string>> = []
        const search = (keys: ReadonlyArray<string>) => {
          searched.push(keys)
          return Effect.succeed(new Map([["RPS-1", "Fix the login"]]))
        }
        yield* TestClock.setTime(10 * day)
        yield* refreshTicketTitles(["RPS-1", "RPS-2"], search)
        yield* refreshTicketTitles(["RPS-1", "RPS-2"], search)
        expect(searched).toEqual([["RPS-1", "RPS-2"]])
        expect(yield* ticketTitles(["RPS-1", "RPS-2", "RPS-3"])).toEqual({
          "RPS-1": { _tag: "Known", summary: "Fix the login" },
          "RPS-2": { _tag: "Unknown", reason: "NotFound" },
          "RPS-3": { _tag: "Unknown", reason: "NotLookedUp" }
        })
        yield* TestClock.adjust(day + 1)
        yield* refreshTicketTitles(["RPS-1"], search)
        expect(searched).toHaveLength(2)
      }))

    it.effect("reports a failed lookup and caches nothing for it", () =>
      Effect.gen(function*() {
        const failures = yield* refreshTicketTitles(
          ["ABC-9"],
          () => Effect.fail(new TicketLookupFailed({ reason: "acli is not installed" }))
        )
        expect(failures).toEqual([new TicketLookupFailed({ reason: "acli is not installed" })])
        expect((yield* ticketTitles(["ABC-9"]))["ABC-9"]).toEqual({ _tag: "Unknown", reason: "NotLookedUp" })
      }))
  })

  describe("searchOutcome", () => {
    it.effect("treats a nonzero exit as a failed lookup even when it printed a reply", () =>
      Effect.gen(function*() {
        expect(yield* Effect.flip(searchOutcome(1, "[]"))).toEqual(
          new TicketLookupFailed({ reason: "acli exited with status 1" })
        )
        expect((yield* searchOutcome(0, "[]")).size).toBe(0)
        const found = yield* searchOutcome(0, JSON.stringify([{ key: "RPS-1", fields: { summary: "Fix login" } }]))
        expect(found.get("RPS-1")).toBe("Fix login")
      }))
  })
})
