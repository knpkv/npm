/**
 * In-memory cache for Atlassian user info.
 *
 * @module
 */
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Ref from "effect/Ref"
import type { AtlassianUser } from "../Schemas.js"

/**
 * User cache service for caching Atlassian user lookups.
 *
 * @category Cache
 */
export class UserCache extends Context.Tag("@knpkv/confluence-to-markdown/UserCache")<
  UserCache,
  {
    /**
     * Get user from cache, or fetch and cache if not present.
     */
    readonly getOrFetch: (
      accountId: string,
      fetch: (accountId: string) => Effect.Effect<AtlassianUser, unknown>
    ) => Effect.Effect<AtlassianUser, unknown>

    /**
     * Get user from cache only (no fetch).
     */
    readonly get: (accountId: string) => Effect.Effect<AtlassianUser | undefined>

    /**
     * Put user into cache.
     */
    readonly put: (accountId: string, user: AtlassianUser) => Effect.Effect<void>

    /**
     * Clear the cache.
     */
    readonly clear: () => Effect.Effect<void>
  }
>() {}

/**
 * Create the user cache service.
 */
const make = Effect.gen(function*() {
  const cache = yield* Ref.make<Map<string, AtlassianUser>>(new Map())

  const get = (accountId: string): Effect.Effect<AtlassianUser | undefined> =>
    Ref.get(cache).pipe(Effect.map((m) => m.get(accountId)))

  const put = (accountId: string, user: AtlassianUser): Effect.Effect<void> =>
    Ref.update(cache, (m) => {
      const newMap = new Map(m)
      newMap.set(accountId, user)
      return newMap
    })

  const getOrFetch = <E>(
    accountId: string,
    fetch: (accountId: string) => Effect.Effect<AtlassianUser, E>
  ): Effect.Effect<AtlassianUser, E> =>
    Effect.gen(function*() {
      const cached = yield* get(accountId)
      if (cached) {
        return cached
      }
      const user = yield* fetch(accountId)
      yield* put(accountId, user)
      return user
    })

  const clear = (): Effect.Effect<void> => Ref.set(cache, new Map())

  return UserCache.of({
    getOrFetch,
    get,
    put,
    clear
  })
})

/**
 * Layer that provides UserCache.
 *
 * @category Layers
 */
export const UserCacheLayer: Layer.Layer<UserCache> = Layer.effect(UserCache, make)
