/**
 * In-memory cache for Atlassian user info.
 *
 * @module
 */
import * as Cache from "effect/Cache"
import * as Context from "effect/Context"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import { ConfluenceClient } from "../ConfluenceClient.js"
import type { ApiError, RateLimitError } from "../ConfluenceError.js"
import type { AtlassianUser } from "../Schemas.js"

const USER_CACHE_CAPACITY = 1_024
const USER_CACHE_SUCCESS_TTL = Duration.hours(1)

/** @internal */
export interface UserCacheOptions {
  readonly capacity?: number
  readonly successTtl?: Duration.Duration
}

/**
 * User cache service for caching Atlassian user lookups.
 *
 * @category Cache
 */
export class UserCache extends Context.Service<
  UserCache,
  {
    /** Get user information, sharing concurrent misses for the same account. */
    readonly get: (accountId: string) => Effect.Effect<AtlassianUser, ApiError | RateLimitError>

    /**
     * Clear the cache.
     */
    readonly clear: () => Effect.Effect<void>
  }
>()("@knpkv/confluence-to-markdown/UserCache") {}

/**
 * Create the user cache service.
 */
const make = (
  loadUser: (accountId: string) => Effect.Effect<AtlassianUser, ApiError | RateLimitError>,
  options: UserCacheOptions = {}
) =>
  Effect.gen(function*() {
    const cache = yield* Cache.makeWith(loadUser, {
      capacity: options.capacity ?? USER_CACHE_CAPACITY,
      timeToLive: (exit) =>
        Exit.isSuccess(exit)
          ? options.successTtl ?? USER_CACHE_SUCCESS_TTL
          : Duration.zero
    })

    return UserCache.of({
      get: (accountId) => Cache.get(cache, accountId),
      clear: () => Cache.invalidateAll(cache)
    })
  })

/** @internal */
export const UserCacheLayerWith = (
  loadUser: (accountId: string) => Effect.Effect<AtlassianUser, ApiError | RateLimitError>,
  options?: UserCacheOptions
): Layer.Layer<UserCache> => Layer.effect(UserCache, make(loadUser, options))

/**
 * Layer that provides UserCache.
 *
 * @category Layers
 */
export const UserCacheLayer: Layer.Layer<UserCache, never, ConfluenceClient> = Layer.effect(
  UserCache,
  Effect.flatMap(ConfluenceClient, (client) => make(client.getUser))
)
