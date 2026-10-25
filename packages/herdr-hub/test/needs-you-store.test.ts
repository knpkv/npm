import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Effect, FileSystem, Path } from "effect"
import { TestClock } from "effect/testing"
import { fleetJobKey, makeNeedsYouStore, retryClaimStaleMillis } from "../src/needs-you-store.js"

const openStore = Effect.fn("NeedsYouStoreTest.open")(function*() {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "needs-you-store-" })
  return yield* makeNeedsYouStore(path.join(directory, "needs-you.sqlite"))
})

const failed = { host: "SER8", jobId: "job-1" }

describe("Needs-you store", () => {
  it.layer(NodeServices.layer)((it) => {
    it.effect("a dismissal settles the failure on any host case, and dismissing twice is fine", () =>
      Effect.gen(function*() {
        const store = yield* openStore()
        yield* store.dismiss(failed, "owner@example.com")
        yield* store.dismiss({ host: "ser8", jobId: "job-1" }, "someone-else@example.com")
        const settled = yield* store.settled([{ host: "ser8", jobId: "job-1" }, { host: "SER8", jobId: "job-2" }])
        expect([...settled]).toEqual([fleetJobKey(failed)])
      }).pipe(Effect.scoped))

    it.effect("a second claim is refused, with the first retry's job once it has one", () =>
      Effect.gen(function*() {
        const store = yield* openStore()
        yield* store.claimRetry(failed, "owner@example.com")
        expect(yield* Effect.flip(store.claimRetry(failed, "owner@example.com"))).toMatchObject({
          _tag: "RetryAlreadyClaimed",
          retryJobId: null
        })
        yield* store.fillRetry(failed, "job-9")
        expect(yield* Effect.flip(store.claimRetry({ host: "ser8", jobId: "job-1" }, "owner@example.com")))
          .toMatchObject({ _tag: "RetryAlreadyClaimed", retryJobId: "job-9" })
      }).pipe(Effect.scoped))

    it.effect("only a filled retry hides the failure; an in-flight claim doesn't", () =>
      Effect.gen(function*() {
        const store = yield* openStore()
        yield* store.claimRetry(failed, "owner@example.com")
        expect((yield* store.settled([failed])).size).toBe(0)
        yield* store.fillRetry(failed, "job-9")
        expect((yield* store.settled([failed])).size).toBe(1)
      }).pipe(Effect.scoped))

    it.effect("a released claim, and one orphaned past the stale limit, can be claimed again", () =>
      Effect.gen(function*() {
        const store = yield* openStore()
        yield* store.claimRetry(failed, "owner@example.com")
        yield* store.releaseRetry(failed)
        yield* store.claimRetry(failed, "owner@example.com")
        yield* TestClock.adjust(retryClaimStaleMillis - 1)
        expect(yield* Effect.flip(store.claimRetry(failed, "owner@example.com"))).toMatchObject({
          _tag: "RetryAlreadyClaimed"
        })
        yield* TestClock.adjust(1)
        yield* store.claimRetry(failed, "owner@example.com")
      }).pipe(Effect.scoped))

    it.effect("releasing never drops a filled retry", () =>
      Effect.gen(function*() {
        const store = yield* openStore()
        yield* store.claimRetry(failed, "owner@example.com")
        yield* store.fillRetry(failed, "job-9")
        yield* store.releaseRetry(failed)
        expect((yield* store.settled([failed])).size).toBe(1)
      }).pipe(Effect.scoped))
  })
})
