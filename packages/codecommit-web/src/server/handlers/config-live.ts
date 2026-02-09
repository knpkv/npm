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
            Effect.catchAll(() => Effect.succeed({ accounts: [], autoDetect: true }))
          )
          const state = yield* SubscriptionRef.get(prService.state)
          return {
            accounts: config.accounts.map((a) => ({
              profile: a.profile,
              regions: a.regions,
              enabled: a.enabled
            })),
            autoDetect: config.autoDetect,
            currentUser: state.currentUser
          }
        }))
      .handle("path", () =>
        Effect.gen(function*() {
          const fs = yield* FileSystem.FileSystem
          const path = yield* configService.getConfigPath.pipe(
            Effect.catchAll((e) => Effect.fail(new ApiError({ message: e.message })))
          )
          const exists = yield* fs.exists(path).pipe(Effect.catchAll(() => Effect.succeed(false)))
          return { path, exists }
        }).pipe(Effect.catchTag("ApiError", Effect.fail)))
      .handle("validate", () =>
        Effect.gen(function*() {
          const result = yield* configService.validate.pipe(
            Effect.catchAll((e) => Effect.fail(new ApiError({ message: e.message })))
          )
          return { status: result.status, path: result.path, errors: result.errors }
        }).pipe(Effect.catchTag("ApiError", Effect.fail)))
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
            autoDetect: payload.autoDetect
          }).pipe(
            Effect.mapError((e) => new ApiError({ message: e.message }))
          )
          yield* prService.refresh.pipe(Effect.catchAll(() => Effect.void))
          return "ok"
        }))
      .handle("reset", () =>
        Effect.gen(function*() {
          const backupPath = yield* configService.backup.pipe(
            Effect.map((p): string | undefined => p),
            Effect.catchAll(() => Effect.succeed(undefined as string | undefined))
          )
          const config = yield* configService.reset.pipe(
            Effect.mapError((e) => new ApiError({ message: String(e) }))
          )
          yield* prService.refresh.pipe(Effect.catchAll(() => Effect.void))
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
              currentUser: state.currentUser
            }
          }
        }))
  }))
