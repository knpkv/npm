import { describe, expect, it } from "@effect/vitest"
import type { AppState } from "@knpkv/codecommit-core/Domain.js"
import {
  applyIdentityEvent,
  IdentityEvent,
  type ResolvedIdentity,
  startRefresh
} from "@knpkv/codecommit-core/IdentityLifecycle.js"
import { Cause, Deferred, Effect, Exit, Fiber, Ref, SubscriptionRef } from "effect"
import {
  signInAfterLogin,
  signOutAfter,
  ssoFailureMessage,
  SsoLoginFailedError,
  SsoLogoutFailedError
} from "../src/server/handlers/notifications-live.js"

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

  it("names what ran and why it failed in the notification", () => {
    expect(ssoFailureMessage("aws sso logout", new SsoLogoutFailedError({ exitCode: 255 })))
      .toBe("aws sso logout exited with code 255; see the terminal running codecommit for its output.")
    expect(ssoFailureMessage("aws sso login --profile dev", new SsoLoginFailedError({ exitCode: 1 })))
      .toBe("aws sso login --profile dev exited with code 1; see the terminal running codecommit for its output.")
    expect(ssoFailureMessage("aws sso logout", new Cause.TimeoutError()))
      .toBe("aws sso logout didn't finish within 3m; it was stopped.")
    expect(ssoFailureMessage("aws sso logout", { message: "spawn aws ENOENT" }))
      .toBe("aws sso logout could not run: spawn aws ENOENT.")
  })

  it.effect("makes in-flight work stale as soon as the login exits, before its identity lookup returns", () =>
    Effect.gen(function*() {
      const state = yield* SubscriptionRef.make(signedIn())
      const before = (yield* SubscriptionRef.get(state)).identityLifecycle?.generation ?? -1
      const lookupStarted = yield* Deferred.make<void>()
      const lookupMayReturn = yield* Deferred.make<void>()
      const fresh: ResolvedIdentity = {
        accountId: "111111111111",
        arn: "arn:aws:sts::111111111111:assumed-role/R/new",
        username: "new"
      }
      const signingIn = yield* signInAfterLogin(
        Effect.succeed(0),
        Deferred.succeed(lookupStarted, undefined).pipe(
          Effect.andThen(Deferred.await(lookupMayReturn)),
          Effect.as(fresh)
        ),
        "alpha",
        state,
        Effect.void
      ).pipe(Effect.forkChild({ startImmediately: true }))
      yield* Deferred.await(lookupStarted)
      const during = yield* SubscriptionRef.get(state)
      // The session already changed: the old principal is gone and an older refresh's event is stale.
      expect(during.identityLifecycle?.generation).toBe(before + 1)
      expect(during.callerIdentities?.["alpha"]).toBeUndefined()
      const stale = applyIdentityEvent(
        during,
        IdentityEvent.LookupSucceeded({ generation: before, profile: "alpha", identity: fresh })
      )
      expect(stale.callerIdentities?.["alpha"]).toBeUndefined()
      yield* Deferred.succeed(lookupMayReturn, undefined)
      yield* Fiber.join(signingIn)
      expect((yield* SubscriptionRef.get(state)).currentUser).toBe("new")
    }))
})
