/**
 * Notification endpoint handlers — SSO login/logout + CRUD for notifications.
 *
 * Provides list/count/markRead/markUnread/markAllRead for unified notifications,
 * plus ssoLogin (forks daemon: `aws sso login` → getCallerIdentity → refresh)
 * and ssoLogout. Only login success and errors produce system notifications.
 * `ssoSemaphore(1)` serializes concurrent SSO commands.
 *
 * @module
 */
import { AwsClient, CacheService, PRService } from "@knpkv/codecommit-core"
import { type AppState, AwsRegion } from "@knpkv/codecommit-core/Domain.js"
import { type ResolvedIdentity, signInState, signOutState } from "@knpkv/codecommit-core/IdentityLifecycle.js"
import { Data, Duration, Effect, Schema, Semaphore, SubscriptionRef } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { ApiError, CodeCommitApi } from "../Api.js"
import { BackgroundScope } from "../internal/BackgroundScope.js"

const SSO_TIMEOUT = Duration.minutes(3)

const exitCode = (cmd: ChildProcess.Command) =>
  Effect.flatMap(ChildProcessSpawner.ChildProcessSpawner, (spawner) => spawner.exitCode(cmd))

/** `aws sso logout` exited non-zero, so the SSO sessions are still active. */
export class SsoLogoutFailedError extends Data.TaggedError("SsoLogoutFailedError")<{ readonly exitCode: number }> {}

/**
 * Run a logout, then mark the caller signed out of every account (`aws sso logout` ends every SSO
 * session) and refresh: signing out makes the refresh in flight stale, and accounts whose credentials
 * are not SSO resolve again only on the next refresh. A non-zero exit fails instead and leaves the
 * state as it was, because nothing was signed out.
 */
export const signOutAfter = <E, R>(
  logout: Effect.Effect<number, E, R>,
  state: SubscriptionRef.SubscriptionRef<AppState>,
  refresh: Effect.Effect<void>
) =>
  logout.pipe(
    Effect.flatMap((code) =>
      code === 0
        ? SubscriptionRef.update(state, signOutState).pipe(Effect.andThen(refresh))
        : Effect.fail(new SsoLogoutFailedError({ exitCode: code }))
    )
  )

/** `aws sso login` exited non-zero, so nothing was signed in. */
export class SsoLoginFailedError extends Data.TaggedError("SsoLoginFailedError")<{ readonly exitCode: number }> {}

/**
 * Run a login; when it exits 0, sign in with the looked-up identity, if any, then refresh. Signing in
 * makes the refresh in flight stale, including its end, so only a fresh refresh resolves the other
 * accounts and finishes the first resolution. A non-zero exit fails instead and changes nothing.
 */
export const signInAfterLogin = <E, R, R2>(
  login: Effect.Effect<number, E, R>,
  lookup: Effect.Effect<ResolvedIdentity | undefined, never, R2>,
  profile: string,
  state: SubscriptionRef.SubscriptionRef<AppState>,
  refresh: Effect.Effect<void>
) =>
  login.pipe(
    Effect.flatMap((code) => code === 0 ? lookup : Effect.fail(new SsoLoginFailedError({ exitCode: code }))),
    // Even without an identity the session changed, so the sign-in still makes in-flight work stale.
    Effect.flatMap((identity) => SubscriptionRef.update(state, (s) => signInState(s, profile, identity))),
    Effect.andThen(refresh)
  )

export const NotificationsLive = HttpApiBuilder.group(
  CodeCommitApi,
  "notifications",
  (handlers) =>
    Effect.gen(function*() {
      const prService = yield* PRService.PRService
      const awsClient = yield* AwsClient.AwsClient
      const notificationRepo = yield* CacheService.NotificationRepo
      const ssoSemaphore = yield* Semaphore.make(1)
      const ownerScope = yield* BackgroundScope

      return handlers
        .handle("list", ({ query }) =>
          notificationRepo.findAll({
            limit: query.limit ?? 20,
            ...((query.cursor !== undefined) && { cursor: query.cursor }),
            ...((query.filter !== undefined) && { filter: query.filter }),
            ...((query.unreadOnly) && { unreadOnly: true })
          }).pipe(Effect.orDie))
        .handle("count", () =>
          notificationRepo.unreadCount().pipe(
            Effect.map((unread) => ({ unread })),
            Effect.orDie
          ))
        .handle("markRead", ({ payload }) =>
          notificationRepo.markRead(payload.id).pipe(
            Effect.map(() => "ok"),
            Effect.orDie
          ))
        .handle("markUnread", ({ payload }) =>
          notificationRepo.markUnread(payload.id).pipe(
            Effect.map(() => "ok"),
            Effect.orDie
          ))
        .handle("markAllRead", () =>
          notificationRepo.markAllRead().pipe(
            Effect.map(() => "ok"),
            Effect.orDie
          ))
        .handle("ssoLogin", ({ payload }) =>
          Effect.gen(function*() {
            const cmd = ChildProcess.make("aws", ["sso", "login", "--profile", payload.profile], {
              stdout: "inherit",
              stderr: "inherit"
            })
            yield* Effect.forkIn(
              ssoSemaphore.withPermits(1)(
                signInAfterLogin(
                  exitCode(cmd).pipe(Effect.timeout(SSO_TIMEOUT)),
                  Effect.gen(function*() {
                    const state = yield* SubscriptionRef.get(prService.state)
                    const account = state.accounts.find((a) => a.profile === payload.profile)
                    const region = account?.region ?? Schema.decodeSync(AwsRegion)("us-east-1")
                    // The login itself succeeded; without an identity the refresh resolves it.
                    return yield* awsClient.getCallerIdentity({ profile: payload.profile, region }).pipe(
                      Effect.orElseSucceed(() => undefined)
                    )
                  }),
                  payload.profile,
                  prService.state,
                  prService.refresh
                ).pipe(
                  // The sign-in and refresh above already ran, so a notification that fails to persist
                  // cannot skip them.
                  Effect.tap(() =>
                    notificationRepo.addSystem({
                      type: "success",
                      title: payload.profile,
                      message: `SSO login successful for ${payload.profile}`,
                      profile: payload.profile
                    }).pipe(Effect.catch((error) => Effect.logWarning("SSO login notification failed", error)))
                  ),
                  Effect.catchIf(() => true, (e) =>
                    Effect.logWarning("SSO login failed", e).pipe(
                      Effect.andThen(notificationRepo.addSystem({
                        type: "error",
                        title: "SSO Login Failed",
                        message: "SSO login failed — check credentials",
                        profile: payload.profile
                      }))
                    ))
                )
              ),
              ownerScope
            )
            return "ok"
          }).pipe(
            Effect.mapError((e) => new ApiError({ message: String(e) || "Failed to start SSO login" }))
          ))
        .handle("ssoLogout", () =>
          Effect.gen(function*() {
            const cmd = ChildProcess.make("aws", ["sso", "logout"], {
              stdout: "inherit",
              stderr: "inherit"
            })
            yield* Effect.forkIn(
              ssoSemaphore.withPermits(1)(
                signOutAfter(exitCode(cmd).pipe(Effect.timeout(SSO_TIMEOUT)), prService.state, prService.refresh).pipe(
                  Effect.catchIf(() => true, (e) =>
                    Effect.logWarning("SSO logout failed", e).pipe(
                      Effect.andThen(notificationRepo.addSystem({
                        type: "error",
                        title: "SSO Logout Failed",
                        message: "SSO logout failed"
                      }))
                    ))
                )
              ),
              ownerScope
            )
            return "ok"
          }).pipe(
            Effect.mapError((e) => new ApiError({ message: String(e) || "Failed to start SSO logout" }))
          ))
    })
)
