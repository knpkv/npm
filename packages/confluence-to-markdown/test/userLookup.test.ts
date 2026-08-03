import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Logger from "effect/Logger"
import { ApiError } from "../src/ConfluenceError.js"
import { UserCache } from "../src/internal/userCache.js"
import { lookupUserForSync } from "../src/internal/userLookup.js"

describe("lookupUserForSync", () => {
  it.effect("logs a failed lookup before omitting author metadata", () =>
    Effect.gen(function*() {
      const failure = new ApiError({
        endpoint: "/user",
        message: "lookup unavailable",
        status: 503
      })
      const messages: Array<unknown> = []
      const logger = Logger.make<unknown, void>((entry) => {
        messages.push(entry.message)
      })
      const cache = UserCache.of({
        clear: () => Effect.void,
        get: () => Effect.fail(failure)
      })

      const user = yield* lookupUserForSync(cache, "account-1").pipe(Effect.withLogger(logger))

      expect(user).toBeUndefined()
      const logged = messages.map(String).join("\n")
      expect(logged).toContain("Confluence user lookup failed for account-1")
      expect(logged).toContain("lookup unavailable")
    }))
})
