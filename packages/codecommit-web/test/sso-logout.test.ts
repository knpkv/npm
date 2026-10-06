import { describe, expect, it } from "@effect/vitest"
import type { AppState } from "@knpkv/codecommit-core/Domain.js"
import { Effect, Exit, SubscriptionRef } from "effect"
import { signOutAfter } from "../src/server/handlers/notifications-live.js"

const signedIn = (): AppState => ({
  pullRequests: [],
  accounts: [],
  status: "idle",
  currentUser: "alice",
  callerIdentities: {
    alpha: {
      _tag: "Resolved",
      accountId: "111111111111",
      arn: "arn:aws:sts::111111111111:assumed-role/R/alice",
      username: "alice"
    }
  }
})

describe("SSO logout", () => {
  it.effect("marks every account signed out when the logout succeeds", () =>
    Effect.gen(function*() {
      const state = yield* SubscriptionRef.make(signedIn())
      yield* signOutAfter(Effect.succeed(0), state)
      const after = yield* SubscriptionRef.get(state)
      expect(after.currentUser).toBeUndefined()
      expect(after.callerIdentities).toEqual({
        alpha: { _tag: "Unresolved", reason: { _tag: "CredentialsUnavailable" } }
      })
    }))

  it.effect("fails and keeps every identity when the logout exits non-zero", () =>
    Effect.gen(function*() {
      const state = yield* SubscriptionRef.make(signedIn())
      const exit = yield* Effect.exit(signOutAfter(Effect.succeed(255), state))
      expect(Exit.isFailure(exit)).toBe(true)
      expect(yield* SubscriptionRef.get(state)).toEqual(signedIn())
    }))
})
