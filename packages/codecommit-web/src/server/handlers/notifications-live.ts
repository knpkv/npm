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
import { type AppState, AwsRegion, type CallerIdentityState, signOutState } from "@knpkv/codecommit-core/Domain.js"
import { Data, Duration, Effect, Schema, Semaphore, SubscriptionRef } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { ApiError, CodeCommitApi } from "../Api.js"
import { BackgroundScope } from "../internal/BackgroundScope.js"

const SSO_TIMEOUT = Duration.minutes(3)

const resolvedIdentity = (identity: AwsClient.CallerIdentity): CallerIdentityState => ({
  _tag: "Resolved",
  accountId: identity.accountId,
  arn: identity.arn,
  username: identity.username
})

const exitCode = (cmd: ChildProcess.Command) =>
  Effect.flatMap(ChildProcessSpawner.ChildProcessSpawner, (spawner) => spawner.exitCode(cmd))

/** `aws sso logout` exited non-zero, so the SSO sessions are still active. */
export class SsoLogoutFailedError extends Data.TaggedError("SsoLogoutFailedError")<{ readonly exitCode: number }> {}

/**
 * Run a logout, then mark the caller signed out of every account: `aws sso logout` ends every SSO
 * session. A non-zero exit fails instead and leaves the state as it was, because nothing was signed out.
 */
export const signOutAfter = <E, R>(
  logout: Effect.Effect<number, E, R>,
  state: SubscriptionRef.SubscriptionRef<AppState>
) =>
  logout.pipe(
    Effect.flatMap((code) =>
      code === 0
        ? SubscriptionRef.update(state, signOutState)
        : Effect.fail(new SsoLogoutFailedError({ exitCode: code }))
    )
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
                exitCode(cmd).pipe(
                  Effect.timeout(SSO_TIMEOUT),
                  Effect.tap(() =>
                    Effect.gen(function*() {
                      const state = yield* SubscriptionRef.get(prService.state)
                      const account = state.accounts.find((a) => a.profile === payload.profile)
                      const region = account?.region ?? Schema.decodeSync(AwsRegion)("us-east-1")
                      const identity = yield* awsClient.getCallerIdentity({
                        profile: payload.profile,
                        region
                      }).pipe(Effect.catchIf(() => true, () => Effect.succeed(undefined)))
                      if (identity) {
                        yield* SubscriptionRef.update(prService.state, (s) => ({
                          ...s,
                          currentUser: identity.username,
                          callerIdentities: { ...s.callerIdentities, [payload.profile]: resolvedIdentity(identity) }
                        }))
                      }
                    })
                  ),
                  Effect.tap(() =>
                    notificationRepo.addSystem({
                      type: "success",
                      title: payload.profile,
                      message: `SSO login successful for ${payload.profile}`,
                      profile: payload.profile
                    })
                  ),
                  Effect.tap(() => prService.refresh),
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
                signOutAfter(exitCode(cmd).pipe(Effect.timeout(SSO_TIMEOUT)), prService.state).pipe(
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
