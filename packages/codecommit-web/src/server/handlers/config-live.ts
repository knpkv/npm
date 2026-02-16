import { FileSystem, HttpApiBuilder } from "@effect/platform"
import { ConfigService, PRService } from "@knpkv/codecommit-core"
import { AwsProfileName, AwsRegion } from "@knpkv/codecommit-core/Domain.js"
import { Effect, Schema, SubscriptionRef } from "effect"
import { ApiError, CodeCommitApi } from "../Api.js"

export const ConfigLive = HttpApiBuilder.group(CodeCommitApi, "config", (handlers) =>
  Effect.gen(function*() {
    const configService = yield* ConfigService.ConfigService
    const prService = yield* PRService.PRService

    return handlers
      .handle("list", () =>
        Effect.gen(function*() {
          const config = yield* configService.load.pipe(
            Effect.catchAll(() =>
              Effect.succeed({ accounts: [], autoDetect: true, autoRefresh: true, refreshIntervalSeconds: 300 })
            )
          )
          const state = yield* SubscriptionRef.get(prService.state)
          return {
            accounts: config.accounts.map((a) => ({
              profile: a.profile,
              regions: a.regions,
              enabled: a.enabled
            })),
            autoDetect: config.autoDetect,
            autoRefresh: config.autoRefresh,
            refreshIntervalSeconds: config.refreshIntervalSeconds,
            currentUser: state.currentUser
          }
        }).pipe(Effect.orDie))
      .handle("path", () =>
        Effect.gen(function*() {
          const fs = yield* FileSystem.FileSystem
          const path = yield* configService.getConfigPath
          const exists = yield* fs.exists(path).pipe(Effect.catchAll(() => Effect.succeed(false)))
          return { path, exists }
        }).pipe(Effect.mapError((e) => new ApiError({ message: e.message }))))
      .handle("validate", () =>
        Effect.gen(function*() {
          const result = yield* configService.validate
          return { status: result.status, path: result.path, errors: result.errors }
        }).pipe(Effect.mapError((e) => new ApiError({ message: e.message }))))
      .handle("save", ({ payload }) =>
        Effect.gen(function*() {
          const decodeProfile = Schema.decodeSync(AwsProfileName)
          const decodeRegion = Schema.decodeSync(AwsRegion)
          yield* configService.save({
            accounts: payload.accounts.map((a) => ({
              profile: decodeProfile(a.profile),
              regions: a.regions.map((r) => decodeRegion(r)),
              enabled: a.enabled
            })),
            autoDetect: payload.autoDetect,
            autoRefresh: payload.autoRefresh,
            refreshIntervalSeconds: payload.refreshIntervalSeconds
          })
          yield* prService.refresh.pipe(
            Effect.catchAll((e) => Effect.logWarning("refresh after config save failed", e))
          )
          return "ok"
        }).pipe(Effect.mapError((e) => new ApiError({ message: e.message }))))
      .handle("reset", () =>
        Effect.gen(function*() {
          const backupPath = yield* configService.backup.pipe(
            Effect.map((p): string | undefined => p),
            Effect.catchAll(() => Effect.succeed(undefined as string | undefined))
          )
          const config = yield* configService.reset
          yield* prService.refresh.pipe(
            Effect.catchAll((e) => Effect.logWarning("refresh after config reset failed", e))
          )
          const state = yield* SubscriptionRef.get(prService.state)
          return {
            backupPath,
            config: {
              accounts: config.accounts.map((a) => ({
                profile: a.profile,
                regions: a.regions,
                enabled: a.enabled
              })),
              autoDetect: config.autoDetect,
              autoRefresh: config.autoRefresh,
              refreshIntervalSeconds: config.refreshIntervalSeconds,
              currentUser: state.currentUser
            }
          }
        }).pipe(Effect.mapError((e) => new ApiError({ message: String(e) }))))
  }))
