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
import type { AwsRegion } from "@knpkv/codecommit-core/Domain.js"
import { Duration, Effect, Semaphore, SubscriptionRef } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { ApiError, CodeCommitApi } from "../Api.js"

const SSO_TIMEOUT = Duration.minutes(3)

const exitCode = (cmd: ChildProcess.Command) =>
  Effect.flatMap(ChildProcessSpawner.ChildProcessSpawner, (spawner) => spawner.exitCode(cmd))

export const NotificationsLive = HttpApiBuilder.group(
  CodeCommitApi,
  "notifications",
  (handlers) =>
    Effect.gen(function*() {
      const prService = yield* PRService.PRService
      const awsClient = yield* AwsClient.AwsClient
      const notificationRepo = yield* CacheService.NotificationRepo
      const ssoSemaphore = yield* Semaphore.make(1)

      return handlers
        .handle("list", ({ query }) =>
          notificationRepo.findAll({
            limit: query.limit ?? 20,
            ...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
            ...(query.filter !== undefined ? { filter: query.filter } : {}),
            ...(query.unreadOnly ? { unreadOnly: true } : {})
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
            yield* Effect.forkDetach(
              ssoSemaphore.withPermits(1)(
                exitCode(cmd).pipe(
                  Effect.timeout(SSO_TIMEOUT),
                  Effect.tap(() =>
                    Effect.gen(function*() {
                      const state = yield* SubscriptionRef.get(prService.state)
                      const account = state.accounts.find((a) => a.profile === payload.profile)
                      const region = account?.region ?? ("us-east-1" as AwsRegion)
                      const identity = yield* awsClient.getCallerIdentity({
                        profile: payload.profile,
                        region
                      }).pipe(Effect.catchIf(() => true, () => Effect.succeed(undefined)))
                      if (identity) {
                        yield* SubscriptionRef.update(prService.state, (s) => ({
                          ...s,
                          currentUser: identity.username
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
              )
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
            yield* Effect.forkDetach(
              ssoSemaphore.withPermits(1)(
                exitCode(cmd).pipe(
                  Effect.timeout(SSO_TIMEOUT),
                  Effect.tap(() => SubscriptionRef.update(prService.state, ({ currentUser: _, ...rest }) => rest)),
                  Effect.catchIf(() => true, (e) =>
                    Effect.logWarning("SSO logout failed", e).pipe(
                      Effect.andThen(notificationRepo.addSystem({
                        type: "error",
                        title: "SSO Logout Failed",
                        message: "SSO logout failed"
                      }))
                    ))
                )
              )
            )
            return "ok"
          }).pipe(
            Effect.mapError((e) => new ApiError({ message: String(e) || "Failed to start SSO logout" }))
          ))
    })
)
