import { describe, expect, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { makeSandboxHostReads } from "../src/host-server.js"
import { makeMemoryRunLog, makeMemorySandboxStore, PoolContract, seedPool, SpendReading } from "../src/index.js"
import { contract, contractInput } from "./fixtures.js"

const reading = Schema.decodeUnknownSync(SpendReading)

describe("spend", () => {
  it("keeps spend limits optional, with the alarm below the stop", () => {
    const decode = Schema.decodeUnknownResult(PoolContract)
    expect(decode({ ...contractInput, spend: { alarm: 20, stop: 50 } })._tag).toBe("Success")
    expect(decode({ ...contractInput, spend: { alarm: 50, stop: 20 } })._tag).toBe("Failure")
    expect(decode({ ...contractInput, spend: { alarm: 0, stop: 50 } })._tag).toBe("Failure")
    expect(decode({ ...contractInput, spend: { alarm: 20, stop: Number.POSITIVE_INFINITY } })._tag).toBe("Failure")
  })

  it("refuses a negative or non-finite reading", () => {
    expect(() => reading({ accountId: "111111111111", usd: -1, asOf: 0 })).toThrow()
    expect(() => reading({ accountId: "111111111111", usd: Number.NaN, asOf: 0 })).toThrow()
  })

  it.effect("the memory store keeps the latest reading per account", () =>
    Effect.gen(function*() {
      const store = yield* makeMemorySandboxStore(seedPool(contract))
      expect(yield* store.spend).toEqual([])
      yield* store.recordSpend(reading({ accountId: "111111111111", usd: 3.1, asOf: 1_000 }))
      yield* store.recordSpend(reading({ accountId: "111111111111", usd: 7.4, asOf: 2_000 }))
      yield* store.recordSpend(reading({ accountId: "222222222222", usd: 0, asOf: 2_000 }))
      expect(yield* store.spend).toEqual([
        { accountId: "111111111111", usd: 7.4, asOf: 2_000 },
        { accountId: "222222222222", usd: 0, asOf: 2_000 }
      ])
    }))

  it.effect("serves each card's last reading and the pool's limits; none without either", () =>
    Effect.gen(function*() {
      const limited = Schema.decodeUnknownSync(PoolContract)({ ...contractInput, spend: { alarm: 20, stop: 50 } })
      const store = yield* makeMemorySandboxStore(seedPool(limited))
      yield* store.recordSpend(reading({ accountId: "111111111111", usd: 7.4, asOf: 2_000 }))
      const reads = yield* makeSandboxHostReads({ contract: limited, store, runLog: yield* makeMemoryRunLog })
      const overview = yield* reads.overview
      if (overview._tag !== "Ready") throw new Error("expected a ready overview")
      expect(overview.spendLimits).toEqual({ alarm: 20, stop: 50 })
      expect(overview.sandboxes.map(({ accountId, spend }) => [accountId, spend])).toEqual([
        ["111111111111", { usd: 7.4, asOf: 2_000 }],
        ["222222222222", null]
      ])
      const plain = yield* makeSandboxHostReads({
        contract,
        store: yield* makeMemorySandboxStore(seedPool(contract)),
        runLog: yield* makeMemoryRunLog
      })
      const unlimited = yield* plain.overview
      expect(unlimited._tag === "Ready" ? unlimited.spendLimits : "not ready").toBeNull()
    }))
})
