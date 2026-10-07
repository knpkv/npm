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
import {
  applyIdentityEvent,
  beginSignIn,
  IdentityEvent,
  type ResolvedIdentity,
  signOutState
} from "@knpkv/codecommit-core/IdentityLifecycle.js"
import { type Cause, Data, Duration, Effect, Predicate, Schema, Semaphore, SubscriptionRef } from "effect"
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
    Effect.flatMap((code) => code === 0 ? Effect.void : Effect.fail(new SsoLoginFailedError({ exitCode: code }))),
    // The session changed the moment the login succeeded: in-flight work goes stale before the lookup.
    Effect.andThen(SubscriptionRef.modify(state, (s) => beginSignIn(s, profile))),
    Effect.flatMap((generation) =>
      lookup.pipe(
        Effect.flatMap((identity) =>
          identity === undefined
            ? Effect.void
            : SubscriptionRef.update(
              state,
              (s) => applyIdentityEvent(s, IdentityEvent.LookupSucceeded({ generation, profile, identity }))
            )
        )
      )
    ),
    Effect.andThen(refresh)
  )

/**
 * The notification text for a failed SSO command: what ran and why it failed, so the user can act on
 * it. Provider output went to the terminal (stdio is inherited), so the exit code is the cause known
 * here.
 */
export const ssoFailureMessage = (
  command: string,
  error: SsoLoginFailedError | SsoLogoutFailedError | Cause.TimeoutError | { readonly message?: string }
): string =>
  Predicate.isTagged(error, "SsoLogoutFailedError") || Predicate.isTagged(error, "SsoLoginFailedError")
    ? `${command} exited with code ${error.exitCode}; see the terminal running codecommit for its output.`
    : Predicate.isTagged(error, "TimeoutError")
    ? `${command} didn't finish within ${Duration.format(SSO_TIMEOUT)}; it was stopped.`
    : `${command} could not run${error.message === undefined || error.message === "" ? "" : `: ${error.message}`}.`

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
                      // ast-grep-ignore: no-silent-catch-all -- follow-up: silent fallback; fail with a typed error, log it, or mark it best-effort
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
                        title: "SSO sign-in failed",
                        message: ssoFailureMessage(`aws sso login --profile ${payload.profile}`, e),
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
                  Effect.andThen(
                    notificationRepo.addSystem({
                      type: "success",
                      title: "Signed out of AWS SSO",
                      message: "Signed out of AWS SSO for all profiles on this machine. Sign in again from Accounts."
                    }).pipe(Effect.catch((error) => Effect.logWarning("SSO logout notification failed", error)))
                  ),
                  Effect.catchIf(() => true, (e) =>
                    Effect.logWarning("SSO logout failed", e).pipe(
                      Effect.andThen(notificationRepo.addSystem({
                        type: "error",
                        title: "SSO sign-out failed",
                        message: `${ssoFailureMessage("aws sso logout", e)} Your SSO sessions are still active.`
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
