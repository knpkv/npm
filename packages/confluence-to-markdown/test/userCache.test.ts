import { describe, expect, it } from "@effect/vitest"
import { Deferred, Effect, Exit, Fiber, Ref } from "effect"
import { TestClock } from "effect/testing"
import { ApiError } from "../src/ConfluenceError.js"
import { UserCache, UserCacheLayerWith } from "../src/internal/userCache.js"
import type { AtlassianUser } from "../src/Schemas.js"

const user = (accountId: string): AtlassianUser => ({
  accountId,
  displayName: `User ${accountId}`
})

describe("UserCache", () => {
  it.effect("shares an in-progress lookup for concurrent callers", () => {
    const calls = Ref.makeUnsafe(0)
    const started = Deferred.makeUnsafe<void>()
    const release = Deferred.makeUnsafe<void>()

    return Effect.gen(function*() {
      const cache = yield* UserCache
      const first = yield* Effect.forkChild(cache.get("account-1"))
      const second = yield* Effect.forkChild(cache.get("account-1"))
      yield* Deferred.await(started)

      expect(yield* Ref.get(calls)).toBe(1)
      yield* Deferred.succeed(release, undefined)
      expect((yield* Fiber.join(first)).accountId).toBe("account-1")
      expect((yield* Fiber.join(second)).accountId).toBe("account-1")
    }).pipe(
      Effect.provide(UserCacheLayerWith((accountId) =>
        Effect.gen(function*() {
          yield* Ref.update(calls, (count) => count + 1)
          yield* Deferred.succeed(started, undefined)
          yield* Deferred.await(release)
          return user(accountId)
        })
      ))
    )
  })

  it.effect("reloads a successful entry after its TTL", () => {
    const calls = Ref.makeUnsafe(0)

    return Effect.gen(function*() {
      const cache = yield* UserCache
      yield* cache.get("account-1")
      yield* cache.get("account-1")
      expect(yield* Ref.get(calls)).toBe(1)

      yield* TestClock.adjust("61 minutes")
      yield* cache.get("account-1")
      expect(yield* Ref.get(calls)).toBe(2)
    }).pipe(
      Effect.provide(UserCacheLayerWith((accountId) =>
        Ref.updateAndGet(calls, (count) => count + 1).pipe(
          Effect.as(user(accountId))
        )
      ))
    )
  })

  it.effect("evicts entries when the configured capacity is exceeded", () => {
    const calls = Ref.makeUnsafe(0)

    return Effect.gen(function*() {
      const cache = yield* UserCache
      yield* cache.get("account-1")
      yield* cache.get("account-2")
      yield* cache.get("account-1")
      expect(yield* Ref.get(calls)).toBe(3)
    }).pipe(
      Effect.provide(UserCacheLayerWith(
        (accountId) =>
          Ref.update(calls, (count) => count + 1).pipe(
            Effect.as(user(accountId))
          ),
        { capacity: 1 }
      ))
    )
  })

  it.effect("does not cache a typed lookup failure", () => {
    const calls = Ref.makeUnsafe(0)
    const failure = new ApiError({ status: 503, endpoint: "/users", message: "unavailable" })

    return Effect.gen(function*() {
      const cache = yield* UserCache
      yield* cache.get("account-1").pipe(Effect.flip)
      const loaded = yield* cache.get("account-1")
      expect(loaded.accountId).toBe("account-1")
      expect(yield* Ref.get(calls)).toBe(2)
    }).pipe(
      Effect.provide(UserCacheLayerWith(
        (accountId) =>
          Ref.updateAndGet(calls, (count) => count + 1).pipe(
            Effect.flatMap((attempt) => attempt === 1 ? Effect.fail(failure) : Effect.succeed(user(accountId)))
          )
      ))
    )
  })

  it.effect("does not cache a lookup defect", () => {
    const calls = Ref.makeUnsafe(0)

    return Effect.gen(function*() {
      const cache = yield* UserCache
      const first = yield* Effect.exit(cache.get("account-1"))
      expect(Exit.hasDies(first)).toBe(true)

      const loaded = yield* cache.get("account-1")
      expect(loaded.accountId).toBe("account-1")
      expect(yield* Ref.get(calls)).toBe(2)
    }).pipe(
      Effect.provide(UserCacheLayerWith((accountId) =>
        Ref.updateAndGet(calls, (count) => count + 1).pipe(
          Effect.flatMap((attempt) => attempt === 1 ? Effect.die("provider defect") : Effect.succeed(user(accountId)))
        )
      ))
    )
  })

  it.effect("does not cache an interrupted lookup", () => {
    const calls = Ref.makeUnsafe(0)
    const started = Deferred.makeUnsafe<void>()
    const releaseFirstLookup = Deferred.makeUnsafe<void>()

    return Effect.gen(function*() {
      const cache = yield* UserCache
      const first = yield* Effect.forkChild(cache.get("account-1"))
      yield* Deferred.await(started)
      yield* Fiber.interrupt(first)

      const loaded = yield* cache.get("account-1")
      expect(loaded.accountId).toBe("account-1")
      expect(yield* Ref.get(calls)).toBe(2)
    }).pipe(
      Effect.provide(UserCacheLayerWith((accountId) =>
        Effect.gen(function*() {
          const attempt = yield* Ref.updateAndGet(calls, (count) => count + 1)
          if (attempt === 1) {
            yield* Deferred.succeed(started, undefined)
            yield* Deferred.await(releaseFirstLookup)
          }
          return user(accountId)
        })
      ))
    )
  })
})
