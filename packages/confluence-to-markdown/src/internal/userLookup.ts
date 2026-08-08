import * as Effect from "effect/Effect"
import type { AtlassianUser } from "../Schemas.js"
import type { UserCache } from "./userCache.js"

/** @internal */
export const lookupUserForSync = Effect.fn("SyncEngine.lookupUserForSync")(function*(
  userCache: UserCache["Service"],
  accountId: string
) {
  return yield* userCache.get(accountId).pipe(
    Effect.tapError((error) =>
      Effect.logWarning(
        `Confluence user lookup failed for ${accountId}; omitting author metadata`,
        error
      )
    ),
    Effect.orElseSucceed((): AtlassianUser | undefined => undefined)
  )
})
