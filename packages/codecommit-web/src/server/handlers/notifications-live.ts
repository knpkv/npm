import { Command, HttpApiBuilder } from "@effect/platform"
import { AwsClient, CacheService, PRService } from "@knpkv/codecommit-core"
import type { AwsRegion } from "@knpkv/codecommit-core/Domain.js"
import { Duration, Effect, SubscriptionRef } from "effect"
import { ApiError, CodeCommitApi } from "../Api.js"

const SSO_TIMEOUT = Duration.minutes(3)

export const NotificationsLive = HttpApiBuilder.group(
  CodeCommitApi,
  "notifications",
  (handlers) =>
    Effect.gen(function*() {
      const prService = yield* PRService.PRService
      const awsClient = yield* AwsClient.AwsClient
      const notificationRepo = yield* CacheService.NotificationRepo
      const ssoSemaphore = yield* Effect.makeSemaphore(1)

      return handlers
        .handle("list", ({ urlParams }) =>
          notificationRepo.findAll({
            limit: urlParams.limit ?? 20,
            ...(urlParams.cursor !== undefined ? { cursor: urlParams.cursor } : {}),
            ...(urlParams.filter !== undefined ? { filter: urlParams.filter } : {}),
            ...(urlParams.unreadOnly ? { unreadOnly: true } : {})
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
            yield* notificationRepo.addSystem({
              type: "info",
              title: payload.profile,
              message: `Starting SSO login for ${payload.profile}...`,
              profile: payload.profile
            })

            const cmd = Command.make("aws", "sso", "login", "--profile", payload.profile).pipe(
              Command.stdout("inherit"),
              Command.stderr("inherit")
            )
            yield* Effect.forkDaemon(
              ssoSemaphore.withPermits(1)(
                Command.exitCode(cmd).pipe(
                  Effect.timeout(SSO_TIMEOUT),
                  Effect.tap(() =>
                    Effect.gen(function*() {
                      const state = yield* SubscriptionRef.get(prService.state)
                      const account = state.accounts.find((a) => a.profile === payload.profile)
                      const region = account?.region ?? ("us-east-1" as AwsRegion)
                      const identity = yield* awsClient.getCallerIdentity({
                        profile: payload.profile,
                        region
                      }).pipe(Effect.catchAll(() => Effect.succeed(undefined)))
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
                  Effect.catchAll((e) =>
                    Effect.logWarning("SSO login failed", e).pipe(
                      Effect.zipRight(notificationRepo.addSystem({
                        type: "error",
                        title: "SSO Login Failed",
                        message: "SSO login failed — check credentials",
                        profile: payload.profile
                      }))
                    )
                  )
                )
              )
            )
            return "ok"
          }).pipe(
            Effect.mapError((e) => new ApiError({ message: String(e) || "Failed to start SSO login" }))
          ))
        .handle("ssoLogout", () =>
          Effect.gen(function*() {
            yield* notificationRepo.addSystem({
              type: "info",
              title: "SSO",
              message: "Logging out SSO session..."
            })

            const cmd = Command.make("aws", "sso", "logout").pipe(
              Command.stdout("inherit"),
              Command.stderr("inherit")
            )
            yield* Effect.forkDaemon(
              ssoSemaphore.withPermits(1)(
                Command.exitCode(cmd).pipe(
                  Effect.timeout(SSO_TIMEOUT),
                  Effect.tap(() => SubscriptionRef.update(prService.state, ({ currentUser: _, ...rest }) => rest)),
                  Effect.tap(() =>
                    notificationRepo.addSystem({
                      type: "success",
                      title: "SSO",
                      message: "SSO logout successful"
                    })
                  ),
                  Effect.catchAll((e) =>
                    Effect.logWarning("SSO logout failed", e).pipe(
                      Effect.zipRight(notificationRepo.addSystem({
                        type: "error",
                        title: "SSO Logout Failed",
                        message: "SSO logout failed"
                      }))
                    )
                  )
                )
              )
            )
            return "ok"
          }).pipe(
            Effect.mapError((e) => new ApiError({ message: String(e) || "Failed to start SSO logout" }))
          ))
    })
)
