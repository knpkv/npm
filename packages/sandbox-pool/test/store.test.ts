import { describe, expect, it } from "@effect/vitest"
import { DateTime, Effect, Schema } from "effect"
import {
  AccountId,
  Holder,
  lease,
  makeMemorySandboxStore,
  PoolContract,
  SandboxName,
  SandboxStore,
  seedPool
} from "../src/index.js"
import { contract, contractInput } from "./fixtures.js"

const agent = Schema.decodeUnknownSync(Holder)("agent-a")
const other = Schema.decodeUnknownSync(Holder)("agent-b")
const t0 = DateTime.makeUnsafe("2026-10-16T08:00:00Z")
const seeded = Effect.provideServiceEffect(SandboxStore, makeMemorySandboxStore(seedPool(contract)))

describe("pool contract", () => {
  it("decodes a pool and refuses one whose accounts collide, sit in the blocklist or whose blocklist is empty", () => {
    const decode = Schema.decodeUnknownResult(PoolContract)
    expect(decode(contractInput)._tag).toBe("Success")
    const [first, second] = contractInput.accounts
    if (first === undefined || second === undefined) throw new Error("fixture needs two accounts")
    expect(decode({ ...contractInput, accounts: [first, { ...second, name: first.name }] })._tag).toBe("Failure")
    expect(decode({ ...contractInput, accounts: [first, { ...second, accountId: first.accountId }] })._tag).toBe(
      "Failure"
    )
    expect(decode({ ...contractInput, nukeBlocklist: [...contractInput.nukeBlocklist, first.accountId] })._tag).toBe(
      "Failure"
    )
    expect(decode({ ...contractInput, accounts: [] })._tag).toBe("Failure")
    expect(decode({ ...contractInput, nukeBlocklist: [] })._tag).toBe("Failure")
  })
})

describe("sandbox store", () => {
  it("seeds every pool account as Available, never reset, at version 0", () => {
    expect(seedPool(contract)).toEqual([
      { accountId: "111111111111", name: "sandbox-a", state: { _tag: "Available", lastResetAt: null }, version: 0 },
      { accountId: "222222222222", name: "sandbox-b", state: { _tag: "Available", lastResetAt: null }, version: 0 }
    ])
  })

  it.effect("writes a transition only over the version it was made from", () =>
    Effect.gen(function*() {
      const store = yield* SandboxStore
      const read = yield* store.list
      const first = yield* lease(read, agent, t0)
      const second = yield* lease(read, other, t0)
      expect(yield* store.put(first)).toEqual(first)
      expect(yield* Effect.flip(store.put(second))).toMatchObject({
        _tag: "StaleVersion",
        accountId: second.accountId,
        expected: 0,
        actual: 1
      })
      expect(yield* store.get(first.accountId)).toEqual(first)
    }).pipe(seeded))

  it.effect("refuses a record that skips a version", () =>
    Effect.gen(function*() {
      const store = yield* SandboxStore
      const [current] = yield* store.list
      if (current === undefined) return yield* Effect.die("empty pool")
      expect(yield* Effect.flip(store.put({ ...current, version: current.version + 2 }))).toMatchObject({
        _tag: "StaleVersion",
        expected: 1,
        actual: 0
      })
      expect(yield* store.get(current.accountId)).toEqual(current)
    }).pipe(seeded))

  it.effect("refuses a record that renames its account", () =>
    Effect.gen(function*() {
      const store = yield* SandboxStore
      const [current] = yield* store.list
      if (current === undefined) return yield* Effect.die("empty pool")
      const renamed = { ...current, name: SandboxName.make("sandbox-b"), version: current.version + 1 }
      expect(yield* Effect.flip(store.put(renamed))).toMatchObject({
        _tag: "RecordMismatch",
        accountId: current.accountId,
        stored: "sandbox-a",
        received: "sandbox-b"
      })
      expect(yield* store.get(current.accountId)).toEqual(current)
    }).pipe(seeded))

  it.effect("reports an account outside the pool", () =>
    Effect.gen(function*() {
      const store = yield* SandboxStore
      const missing = AccountId.make("123456789012")
      expect(yield* Effect.flip(store.get(missing))).toMatchObject({ _tag: "SandboxNotFound", accountId: missing })
    }).pipe(seeded))
})
