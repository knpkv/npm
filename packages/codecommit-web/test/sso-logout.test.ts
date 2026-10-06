import { describe, expect, it } from "@effect/vitest"
import type { AppState } from "@knpkv/codecommit-core/Domain.js"
import {
  applyIdentityEvent,
  IdentityEvent,
  type ResolvedIdentity,
  startRefresh
} from "@knpkv/codecommit-core/IdentityLifecycle.js"
import { Effect, Exit, Ref, SubscriptionRef } from "effect"
import { signInAfterLogin, signOutAfter } from "../src/server/handlers/notifications-live.js"

/** Signed in to "alpha", reached through the identity lifecycle's own events. */
const signedIn = (): AppState => {
  const [generation, started] = startRefresh({ pullRequests: [], accounts: [], status: "idle" }, ["alpha"])
  return applyIdentityEvent(
    started,
    IdentityEvent.LookupSucceeded({
      generation,
      profile: "alpha",
      identity: {
        accountId: "111111111111",
        arn: "arn:aws:sts::111111111111:assumed-role/R/alice",
        username: "alice"
      }
    })
  )
}

describe("SSO logout", () => {
  it.effect("marks every account signed out when the logout succeeds, then refreshes", () =>
    Effect.gen(function*() {
      const state = yield* SubscriptionRef.make(signedIn())
      const refreshes = yield* Ref.make(0)
      yield* signOutAfter(Effect.succeed(0), state, Ref.update(refreshes, (n) => n + 1))
      const after = yield* SubscriptionRef.get(state)
      expect(after.currentUser).toBeUndefined()
      expect(after.callerIdentities).toEqual({ alpha: { _tag: "Unresolved", reason: { _tag: "SignedOut" } } })
      // The logout made the refresh in flight stale, so a fresh one runs right away.
      expect(yield* Ref.get(refreshes)).toBe(1)
    }))

  it.effect("fails, keeps every identity and does not refresh when the logout exits non-zero", () =>
    Effect.gen(function*() {
      const state = yield* SubscriptionRef.make(signedIn())
      const refreshes = yield* Ref.make(0)
      const exit = yield* Effect.exit(signOutAfter(Effect.succeed(255), state, Ref.update(refreshes, (n) => n + 1)))
      expect(Exit.isFailure(exit)).toBe(true)
      expect(yield* SubscriptionRef.get(state)).toEqual(signedIn())
      expect(yield* Ref.get(refreshes)).toBe(0)
    }))

  it.effect("refreshes after a login that lands during the first pass, so the first resolution still finishes", () =>
    Effect.gen(function*() {
      // The first pass has started and is still resolving.
      const [, firstPass] = startRefresh({ pullRequests: [], accounts: [], status: "idle" }, ["alpha", "beta"])
      const state = yield* SubscriptionRef.make(firstPass)
      // A refresh: start a pass and finish it, as resolveAccounts does.
      const refresh = SubscriptionRef.update(state, (s) => {
        const [generation, started] = startRefresh(s, ["alpha", "beta"])
        return applyIdentityEvent(started, IdentityEvent.ResolutionFinished({ generation }))
      })
      yield* signInAfterLogin(
        Effect.succeed(0),
        Effect.succeed({
          accountId: "111111111111",
          arn: "arn:aws:sts::111111111111:assumed-role/R/alice",
          username: "alice"
        }),
        "alpha",
        state,
        refresh
      )
      const after = yield* SubscriptionRef.get(state)
      expect(after.identityLifecycle?.firstRefreshDone).toBe(true)
      expect(after.currentUser).toBe("alice")
    }))

  it.effect("makes in-flight work stale after a login whose identity lookup failed, then refreshes", () =>
    Effect.gen(function*() {
      const state = yield* SubscriptionRef.make(signedIn())
      const before = (yield* SubscriptionRef.get(state)).identityLifecycle?.generation ?? -1
      const refreshes = yield* Ref.make(0)
      // The lookup found no identity.
      const noIdentity: ResolvedIdentity | undefined = undefined
      yield* signInAfterLogin(
        Effect.succeed(0),
        Effect.succeed(noIdentity),
        "alpha",
        state,
        Ref.update(refreshes, (n) => n + 1)
      )
      expect((yield* SubscriptionRef.get(state)).identityLifecycle?.generation).toBe(before + 1)
      // The login may have changed the principal, so the old identity and current user are not kept.
      expect((yield* SubscriptionRef.get(state)).callerIdentities?.["alpha"]).toBeUndefined()
      expect((yield* SubscriptionRef.get(state)).currentUser).toBeUndefined()
      expect(yield* Ref.get(refreshes)).toBe(1)
    }))

  it.effect("changes nothing and does not refresh when the login exits non-zero", () =>
    Effect.gen(function*() {
      const state = yield* SubscriptionRef.make(signedIn())
      const refreshes = yield* Ref.make(0)
      const lookups = yield* Ref.make(0)
      const exit = yield* Effect.exit(
        signInAfterLogin(
          Effect.succeed(1),
          Ref.update(lookups, (n) => n + 1).pipe(
            Effect.as({ accountId: "1", arn: "arn:aws:sts::1:assumed-role/R/x", username: "x" })
          ),
          "alpha",
          state,
          Ref.update(refreshes, (n) => n + 1)
        )
      )
      expect(Exit.isFailure(exit)).toBe(true)
      expect(yield* SubscriptionRef.get(state)).toEqual(signedIn())
      expect([yield* Ref.get(lookups), yield* Ref.get(refreshes)]).toEqual([0, 0])
    }))
})
