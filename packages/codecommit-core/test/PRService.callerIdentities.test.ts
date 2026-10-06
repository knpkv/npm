import { describe, expect, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Layer, Schema, Stream, SubscriptionRef } from "effect"
import { AwsClient } from "../src/AwsClient/index.js"
import { CacheError } from "../src/CacheService/CacheError.js"
import { NotificationRepo } from "../src/CacheService/repos/NotificationRepo.js"
import { PullRequestRepo } from "../src/CacheService/repos/PullRequestRepo/index.js"
import { SubscriptionRepo } from "../src/CacheService/repos/SubscriptionRepo.js"
import { ConfigService } from "../src/ConfigService/index.js"
import { TuiConfig } from "../src/ConfigService/internal.js"
import { type AppState, AwsProfileName, AwsRegion, type CallerIdentityState } from "../src/Domain.js"
import { AwsApiError, AwsCredentialError, AwsThrottleError } from "../src/Errors.js"
import { signInState, signOutState } from "../src/IdentityLifecycle.js"
import { resolveAccounts } from "../src/PRService/refreshResolve.js"

const region = Schema.decodeSync(AwsRegion)("us-east-1")
const profile = Schema.decodeSync(AwsProfileName)

const config = Schema.decodeSync(TuiConfig)({
  accounts: ["alpha", "beta", "gamma", "delta", "epsilon"].map((name) => ({
    profile: name,
    regions: ["us-east-1"],
    enabled: true
  }))
})

/** Four accounts: one resolves, the others fail with each error STS lookups can fail with. */
const accounts = Layer.mergeAll(
  Layer.mock(AwsClient, {
    getCallerIdentity: (account) => {
      switch (account.profile) {
        case "alpha":
          return Effect.succeed({
            accountId: "111111111111",
            arn: "arn:aws:sts::111111111111:assumed-role/Reviewers/alice@example.com",
            username: "alice@example.com"
          })
        case "beta":
          return Effect.fail(new AwsCredentialError({ profile: account.profile, region, cause: "sso expired" }))
        case "gamma":
          return Effect.fail(
            new AwsApiError({ operation: "getCallerIdentity", profile: account.profile, region, cause: "denied" })
          )
        case "epsilon":
          // The identity adapter wraps exhausted throttling in AwsApiError.
          return Effect.fail(
            new AwsApiError({
              operation: "getCallerIdentity",
              profile: account.profile,
              region,
              cause: { _tag: "ThrottlingException", message: "Rate exceeded" }
            })
          )
        default:
          return Effect.fail(
            new AwsThrottleError({ operation: "getCallerIdentity", retryCount: 5, cause: "slow down" })
          )
      }
    }
  }),
  Layer.mock(NotificationRepo, { addSystem: () => Effect.void }),
  Layer.mock(PullRequestRepo, { findAll: () => Effect.succeed([]) }),
  Layer.mock(SubscriptionRepo, { findAll: () => Effect.succeed([]) }),
  Layer.mock(ConfigService, { load: Effect.succeed(config), detectProfiles: Effect.succeed([]) })
)

describe("resolveAccounts caller identities", () => {
  it.layer(accounts)((it) => {
    it.effect("publishes every enabled account's identity, and why it is unknown where it failed", () =>
      Effect.gen(function*() {
        const state = yield* SubscriptionRef.make<AppState>({ pullRequests: [], accounts: [], status: "idle" })
        yield* resolveAccounts(state)
        const { callerIdentities } = yield* SubscriptionRef.get(state)
        expect(callerIdentities).toEqual({
          [profile("alpha")]: {
            _tag: "Resolved",
            accountId: "111111111111",
            arn: "arn:aws:sts::111111111111:assumed-role/Reviewers/alice@example.com",
            username: "alice@example.com"
          },
          [profile("beta")]: { _tag: "Unresolved", reason: { _tag: "CredentialsUnavailable" } },
          [profile("gamma")]: { _tag: "Unresolved", reason: { _tag: "StsRejected" } },
          [profile("delta")]: { _tag: "Unresolved", reason: { _tag: "Throttled" } },
          [profile("epsilon")]: { _tag: "Unresolved", reason: { _tag: "Throttled" } }
        })
      }))
  })

  it.effect("clears every identity when no account is enabled", () =>
    Effect.gen(function*() {
      const state = yield* SubscriptionRef.make<AppState>({
        pullRequests: [],
        accounts: [],
        status: "idle",
        callerIdentities: {
          alpha: {
            _tag: "Resolved",
            accountId: "111111111111",
            arn: "arn:aws:sts::111111111111:assumed-role/R/a",
            username: "a"
          }
        }
      })
      const disabled = Layer.mergeAll(
        Layer.mock(AwsClient, {}),
        Layer.mock(NotificationRepo, {}),
        Layer.mock(PullRequestRepo, { findAll: () => Effect.succeed([]) }),
        Layer.mock(SubscriptionRepo, { findAll: () => Effect.succeed([]) }),
        Layer.mock(ConfigService, {
          load: Effect.succeed(
            Schema.decodeSync(TuiConfig)({ accounts: [{ profile: "alpha", regions: ["us-east-1"], enabled: false }] })
          ),
          detectProfiles: Effect.succeed([])
        })
      )
      // Test entry point: this case's own all-disabled configuration is provided once here.
      // @effect-diagnostics-next-line strictEffectProvide:off
      yield* resolveAccounts(state).pipe(Effect.provide(disabled))
      expect((yield* SubscriptionRef.get(state)).callerIdentities).toEqual({})
    }))

  it.effect("publishes nothing a lookup found after an SSO logout lands during the first refresh", () =>
    Effect.gen(function*() {
      const betaMayAnswer = yield* Deferred.make<void>()
      const alphaResolved = yield* Deferred.make<void>()
      // The first refresh: no identities and no current user are known yet.
      const state = yield* SubscriptionRef.make<AppState>({ pullRequests: [], accounts: [], status: "idle" })
      const racing = Layer.mergeAll(
        Layer.mock(AwsClient, {
          getCallerIdentity: (account) =>
            account.profile === "alpha"
              ? Deferred.succeed(alphaResolved, undefined).pipe(
                Effect.as({
                  accountId: "111111111111",
                  arn: "arn:aws:sts::111111111111:assumed-role/R/a",
                  username: "a"
                })
              )
              : Deferred.await(betaMayAnswer).pipe(
                Effect.as({
                  accountId: "222222222222",
                  arn: "arn:aws:sts::222222222222:assumed-role/R/b",
                  username: "b"
                })
              )
        }),
        Layer.mock(NotificationRepo, { addSystem: () => Effect.void }),
        Layer.mock(PullRequestRepo, { findAll: () => Effect.succeed([]) }),
        Layer.mock(SubscriptionRepo, { findAll: () => Effect.succeed([]) }),
        Layer.mock(ConfigService, {
          load: Effect.succeed(
            Schema.decodeSync(TuiConfig)({
              accounts: ["alpha", "beta"].map((name) => ({ profile: name, regions: ["us-east-1"], enabled: true }))
            })
          ),
          detectProfiles: Effect.succeed([])
        })
      )
      // Test entry point: this case's own racing transport is provided once here.
      // @effect-diagnostics-next-line strictEffectProvide:off
      const resolving = yield* resolveAccounts(state).pipe(
        Effect.provide(racing),
        Effect.forkChild({ startImmediately: true })
      )
      yield* Deferred.await(alphaResolved)
      // The production logout transition, while beta is still resolving.
      yield* SubscriptionRef.update(state, signOutState)
      yield* Deferred.succeed(betaMayAnswer, undefined)
      yield* Fiber.join(resolving)
      const after = yield* SubscriptionRef.get(state)
      expect(after.currentUser).toBeUndefined()
      // Alpha was published before the logout, which then signed it out; beta, found after it, is never published.
      expect(after.callerIdentities).toEqual({ alpha: { _tag: "Unresolved", reason: { _tag: "SignedOut" } } })
      // The refresh's start, then the logout.
      expect(after.identityLifecycle?.generation).toBe(2)
    }))

  it.effect("publishes a failed account as soon as its lookup ends, while another is still resolving", () =>
    Effect.gen(function*() {
      const betaMayAnswer = yield* Deferred.make<void>()
      const resolved: CallerIdentityState = {
        _tag: "Resolved",
        accountId: "111111111111",
        arn: "arn:aws:sts::111111111111:assumed-role/R/a",
        username: "a"
      }
      const state = yield* SubscriptionRef.make<AppState>({
        pullRequests: [],
        accounts: [],
        status: "idle",
        callerIdentities: { alpha: resolved }
      })
      const slow = Layer.mergeAll(
        Layer.mock(AwsClient, {
          getCallerIdentity: (account) =>
            account.profile === "alpha"
              ? Effect.fail(new AwsCredentialError({ profile: account.profile, region, cause: "sso expired" }))
              : Deferred.await(betaMayAnswer).pipe(
                Effect.as({
                  accountId: "222222222222",
                  arn: "arn:aws:sts::222222222222:assumed-role/R/b",
                  username: "b"
                })
              )
        }),
        Layer.mock(NotificationRepo, { addSystem: () => Effect.void }),
        Layer.mock(PullRequestRepo, { findAll: () => Effect.succeed([]) }),
        Layer.mock(SubscriptionRepo, { findAll: () => Effect.succeed([]) }),
        Layer.mock(ConfigService, {
          load: Effect.succeed(
            Schema.decodeSync(TuiConfig)({
              accounts: ["alpha", "beta"].map((name) => ({ profile: name, regions: ["us-east-1"], enabled: true }))
            })
          ),
          detectProfiles: Effect.succeed([])
        })
      )
      // Test entry point: this case's own slow transport is provided once here.
      // @effect-diagnostics-next-line strictEffectProvide:off
      const resolving = yield* resolveAccounts(state).pipe(
        Effect.provide(slow),
        Effect.forkChild({ startImmediately: true })
      )
      // Alpha's failure is visible while beta has not answered yet.
      yield* SubscriptionRef.changes(state).pipe(
        Stream.filter((s) => s.callerIdentities?.["alpha"]?._tag === "Unresolved"),
        Stream.take(1),
        Stream.runDrain
      )
      expect((yield* SubscriptionRef.get(state)).callerIdentities?.["beta"]).toBeUndefined()
      yield* Deferred.succeed(betaMayAnswer, undefined)
      yield* Fiber.join(resolving)
      expect((yield* SubscriptionRef.get(state)).callerIdentities?.["beta"]?._tag).toBe("Resolved")
    }))

  it.effect("does not let a lookup that fails after an SSO login clear the login's current user", () =>
    Effect.gen(function*() {
      const lookupStarted = yield* Deferred.make<void>()
      const lookupMayFail = yield* Deferred.make<void>()
      const state = yield* SubscriptionRef.make<AppState>({ pullRequests: [], accounts: [], status: "idle" })
      const login = { accountId: "111111111111", arn: "arn:aws:sts::111111111111:assumed-role/R/new", username: "new" }
      const failing = Layer.mergeAll(
        Layer.mock(AwsClient, {
          getCallerIdentity: (account) =>
            Deferred.succeed(lookupStarted, undefined).pipe(
              Effect.andThen(Deferred.await(lookupMayFail)),
              Effect.andThen(
                Effect.fail(new AwsCredentialError({ profile: account.profile, region, cause: "old session" }))
              )
            )
        }),
        Layer.mock(NotificationRepo, { addSystem: () => Effect.void }),
        Layer.mock(PullRequestRepo, { findAll: () => Effect.succeed([]) }),
        Layer.mock(SubscriptionRepo, { findAll: () => Effect.succeed([]) }),
        Layer.mock(ConfigService, {
          load: Effect.succeed(
            Schema.decodeSync(TuiConfig)({ accounts: [{ profile: "alpha", regions: ["us-east-1"], enabled: true }] })
          ),
          detectProfiles: Effect.succeed([])
        })
      )
      // Test entry point: this case's own failing transport is provided once here.
      // @effect-diagnostics-next-line strictEffectProvide:off
      const resolving = yield* resolveAccounts(state).pipe(
        Effect.provide(failing),
        Effect.forkChild({ startImmediately: true })
      )
      yield* Deferred.await(lookupStarted)
      yield* SubscriptionRef.update(state, (s) => signInState(s, "alpha", login))
      yield* Deferred.succeed(lookupMayFail, undefined)
      yield* Fiber.join(resolving)
      const after = yield* SubscriptionRef.get(state)
      expect(after.currentUser).toBe("new")
      expect(after.callerIdentities?.["alpha"]).toEqual({ _tag: "Resolved", ...login })
    }))

  it.effect("applies a failed lookup even when its notification cannot be stored", () =>
    Effect.gen(function*() {
      const state = yield* SubscriptionRef.make<AppState>({ pullRequests: [], accounts: [], status: "idle" })
      const failing = Layer.mergeAll(
        Layer.mock(AwsClient, {
          getCallerIdentity: (account) =>
            Effect.fail(new AwsCredentialError({ profile: account.profile, region, cause: "sso expired" }))
        }),
        Layer.mock(NotificationRepo, {
          addSystem: () => Effect.fail(new CacheError({ operation: "addSystem", cause: "disk full" }))
        }),
        Layer.mock(PullRequestRepo, { findAll: () => Effect.succeed([]) }),
        Layer.mock(SubscriptionRepo, { findAll: () => Effect.succeed([]) }),
        Layer.mock(ConfigService, {
          load: Effect.succeed(
            Schema.decodeSync(TuiConfig)({ accounts: [{ profile: "alpha", regions: ["us-east-1"], enabled: true }] })
          ),
          detectProfiles: Effect.succeed([])
        })
      )
      // Test entry point: this case's own failing services are provided once here.
      // @effect-diagnostics-next-line strictEffectProvide:off
      yield* resolveAccounts(state).pipe(Effect.provide(failing))
      expect((yield* SubscriptionRef.get(state)).callerIdentities?.["alpha"])
        .toEqual({ _tag: "Unresolved", reason: { _tag: "CredentialsUnavailable" } })
    }))
})
