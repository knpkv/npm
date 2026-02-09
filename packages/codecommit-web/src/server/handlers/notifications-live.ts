import { Command, HttpApiBuilder } from "@effect/platform"
import { NotificationsService } from "@knpkv/codecommit-core"
import { Duration, Effect, SubscriptionRef } from "effect"
import { ApiError, CodeCommitApi } from "../Api.js"

// Limit concurrent SSO commands to 1
const ssoSemaphore = Effect.unsafeMakeSemaphore(1)
const SSO_TIMEOUT = Duration.minutes(3)

export const NotificationsLive = HttpApiBuilder.group(
  CodeCommitApi,
  "notifications",
  (handlers) =>
    Effect.gen(function*() {
      const notificationsService = yield* NotificationsService.NotificationsService

      return handlers
        .handle("list", () =>
          Effect.gen(function*() {
            const state = yield* SubscriptionRef.get(notificationsService.state)
            return state.items.map((item) => ({
              type: item.type,
              title: item.title,
              message: item.message,
              timestamp: item.timestamp.toISOString(),
              ...(item.profile ? { profile: item.profile } : {})
            }))
          }))
        .handle("clear", () =>
          Effect.gen(function*() {
            yield* notificationsService.clear
            return "ok"
          }))
        .handle("ssoLogin", ({ payload }) =>
          Effect.gen(function*() {
            yield* notificationsService.add({
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
                    notificationsService.add({
                      type: "success",
                      title: payload.profile,
                      message: `SSO login successful for ${payload.profile}`,
                      profile: payload.profile
                    })
                  ),
                  Effect.catchAll((e) =>
                    notificationsService.add({
                      type: "error",
                      title: "SSO Login Failed",
                      message: e instanceof Error ? e.message : String(e),
                      profile: payload.profile
                    })
                  )
                )
              )
            )
            return "ok"
          }).pipe(
            Effect.mapError(() => new ApiError({ message: "Failed to start SSO login" }))
          ))
        .handle("ssoLogout", () =>
          Effect.gen(function*() {
            yield* notificationsService.add({
              type: "info",
              title: "SSO Logout",
              message: "Logging out all SSO sessions..."
            })

            const cmd = Command.make("aws", "sso", "logout").pipe(
              Command.stdout("inherit"),
              Command.stderr("inherit")
            )
            yield* Effect.forkDaemon(
              ssoSemaphore.withPermits(1)(
                Command.exitCode(cmd).pipe(
                  Effect.timeout(SSO_TIMEOUT),
                  Effect.tap(() =>
                    notificationsService.add({
                      type: "success",
                      title: "SSO Logout",
                      message: "All SSO sessions logged out"
                    })
                  ),
                  Effect.catchAll((e) =>
                    notificationsService.add({
                      type: "error",
                      title: "SSO Logout Failed",
                      message: e instanceof Error ? e.message : String(e)
                    })
                  )
                )
              )
            )
            return "ok"
          }).pipe(
            Effect.mapError(() => new ApiError({ message: "Failed to start SSO logout" }))
          ))
    })
)
