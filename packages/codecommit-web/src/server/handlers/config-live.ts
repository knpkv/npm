import { ConfigService, PRService } from "@knpkv/codecommit-core"
import { AwsProfileName, AwsRegion } from "@knpkv/codecommit-core/Domain.js"
import { Config, Effect, Option, Predicate, Schema, SubscriptionRef } from "effect"
import * as FileSystem from "effect/FileSystem"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { ApiError, CodeCommitApi } from "../Api.js"

interface ConfigAccountFallback {
  readonly profile: string
  readonly regions: ReadonlyArray<string>
  readonly enabled: boolean
}

export const ConfigLive = HttpApiBuilder.group(CodeCommitApi, "config", (handlers) =>
  Effect.gen(function*() {
    const configService = yield* ConfigService.ConfigService
    const prService = yield* PRService.PRService

    return handlers
      .handle("list", () =>
        Effect.gen(function*() {
          const config = yield* configService.load.pipe(
            Effect.catchIf(() => true, () =>
              Effect.succeed(
                {
                  accounts: [],
                  autoDetect: true,
                  autoRefresh: true,
                  refreshIntervalSeconds: 300,
                  sandbox: ConfigService.defaultSandboxConfig
                } satisfies {
                  readonly accounts: ReadonlyArray<ConfigAccountFallback>
                  readonly autoDetect: boolean
                  readonly autoRefresh: boolean
                  readonly refreshIntervalSeconds: number
                  readonly sandbox: typeof ConfigService.defaultSandboxConfig
                }
              ))
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
            currentUser: state.currentUser,
            sandbox: config.sandbox
          }
        }).pipe(Effect.orDie))
      .handle("path", () =>
        Effect.gen(function*() {
          const fs = yield* FileSystem.FileSystem
          const path = yield* configService.getConfigPath
          const exists = yield* fs.exists(path).pipe(Effect.catchIf(() => true, () => Effect.succeed(false)))
          const modifiedAt = exists
            ? yield* fs.stat(path).pipe(
              Effect.map((s) =>
                Option.map(s.mtime, (d) => new Date(Number(d)).toISOString()).pipe(Option.getOrUndefined)
              ),
              Effect.catchIf(() => true, () => Effect.succeed(undefined))
            )
            : undefined
          return { path, exists, modifiedAt }
        }).pipe(Effect.mapError((e) => new ApiError({ message: Predicate.isError(e) ? e.message : String(e) }))))
      .handle("database", () =>
        Effect.gen(function*() {
          const fs = yield* FileSystem.FileSystem
          const home = yield* Config.string("HOME").pipe(Config.orElse(() => Config.string("USERPROFILE")))
          const path = `${home}/.codecommit/cache.db`
          const exists = yield* fs.exists(path).pipe(Effect.catchIf(() => true, () => Effect.succeed(false)))
          const stat = exists
            ? yield* fs.stat(path).pipe(
              Effect.map((s) => ({
                size: Number(s.size),
                modifiedAt: Option.map(s.mtime, (d) => new Date(Number(d)).toISOString()).pipe(Option.getOrUndefined)
              })),
              Effect.catchIf(() => true, () => Effect.succeed(undefined))
            )
            : undefined
          return { path, sizeBytes: stat?.size ?? 0, exists, modifiedAt: stat?.modifiedAt }
        }).pipe(Effect.mapError((e) => new ApiError({ message: Predicate.isError(e) ? e.message : String(e) }))))
      .handle("validate", () =>
        Effect.gen(function*() {
          const result = yield* configService.validate
          return { status: result.status, path: result.path, errors: result.errors }
        }).pipe(Effect.mapError((e) => new ApiError({ message: String(e) }))))
      .handle("save", ({ payload }) =>
        Effect.gen(function*() {
          const existing = yield* configService.load.pipe(
            Effect.catchIf(() => true, () => Effect.succeed({ sandbox: ConfigService.defaultSandboxConfig }))
          )
          const accounts = yield* Effect.forEach(payload.accounts, (a) =>
            Effect.all({
              profile: Schema.decodeEffect(AwsProfileName)(a.profile),
              regions: Effect.forEach(a.regions, (r) => Schema.decodeEffect(AwsRegion)(r)),
              enabled: Effect.succeed(a.enabled)
            }))
          yield* configService.save({
            accounts,
            autoDetect: payload.autoDetect,
            autoRefresh: payload.autoRefresh,
            refreshIntervalSeconds: payload.refreshIntervalSeconds,
            sandbox: payload.sandbox ?? existing.sandbox
          })
          yield* prService.refresh.pipe(
            Effect.catchIf(() => true, (e) => Effect.logWarning("refresh after config save failed", e))
          )
          return "ok"
        }).pipe(Effect.mapError((e) => new ApiError({ message: String(e) }))))
      .handle("reset", () =>
        Effect.gen(function*() {
          const backupPath = yield* configService.backup.pipe(
            Effect.map((p): string | undefined => p),
            Effect.catchIf(() => true, () => {
              const backupPath: string | undefined = undefined
              return Effect.succeed(backupPath)
            })
          )
          const config = yield* configService.reset
          yield* prService.refresh.pipe(
            Effect.catchIf(() => true, (e) => Effect.logWarning("refresh after config reset failed", e))
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
              currentUser: state.currentUser,
              sandbox: config.sandbox
            }
          }
        }).pipe(Effect.mapError((e) => new ApiError({ message: String(e) }))))
  }))
