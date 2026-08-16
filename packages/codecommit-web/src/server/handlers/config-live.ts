import { ConfigService, PRService } from "@knpkv/codecommit-core"
import { AwsProfileName, AwsRegion } from "@knpkv/codecommit-core/Domain.js"
import { Cause, Config, Effect, Option, Predicate, Schema, SubscriptionRef } from "effect"
import * as FileSystem from "effect/FileSystem"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { ApiError, CodeCommitApi } from "../Api.js"
import { discoverReviewSkills } from "../review/ReviewSkillCatalog.js"

interface ConfigAccountFallback {
  readonly profile: string
  readonly regions: ReadonlyArray<string>
  readonly enabled: boolean
}

export const commitConfigMutation = Effect.fn("ConfigLive.commitConfigMutation")(function*<
  Value,
  MutationError,
  MutationRequirements,
  RefreshRequirements,
  RefreshState extends { readonly status: string; readonly error?: string | undefined }
>(
  mutation: Effect.Effect<Value, MutationError, MutationRequirements>,
  refresh: Effect.Effect<void, never, RefreshRequirements>,
  refreshState: SubscriptionRef.SubscriptionRef<RefreshState>,
  operation: "reset" | "save"
): Effect.fn.Return<
  { readonly value: Value; readonly refreshStatus: "failed" | "refreshed" },
  MutationError,
  MutationRequirements | RefreshRequirements
> {
  const value = yield* mutation
  const refreshed = (): "refreshed" => "refreshed"
  const failed = (): "failed" => "failed"
  const refreshStatus = yield* refresh.pipe(
    Effect.map(refreshed),
    Effect.catchCauseIf(
      (cause) => !Cause.hasInterrupts(cause),
      (cause) => Effect.logWarning(`refresh after config ${operation} failed`, cause).pipe(Effect.map(failed))
    )
  )
  if (refreshStatus === "failed") return { value, refreshStatus }
  const state = yield* SubscriptionRef.get(refreshState)
  if (state.status !== "error") return { value, refreshStatus }
  yield* Effect.logWarning(`refresh after config ${operation} completed in error state`, state.error)
  return { value, refreshStatus: "failed" }
})

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
                  review: ConfigService.defaultReviewConfig,
                  sandbox: ConfigService.defaultSandboxConfig
                } satisfies {
                  readonly accounts: ReadonlyArray<ConfigAccountFallback>
                  readonly autoDetect: boolean
                  readonly autoRefresh: boolean
                  readonly refreshIntervalSeconds: number
                  readonly review: typeof ConfigService.defaultReviewConfig
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
            review: config.review,
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
              Effect.option,
              Effect.map(Option.getOrUndefined)
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
              Effect.option,
              Effect.map(Option.getOrUndefined)
            )
            : undefined
          return { path, sizeBytes: stat?.size ?? 0, exists, modifiedAt: stat?.modifiedAt }
        }).pipe(Effect.mapError((e) => new ApiError({ message: Predicate.isError(e) ? e.message : String(e) }))))
      .handle("validate", () =>
        Effect.gen(function*() {
          const result = yield* configService.validate
          return { status: result.status, path: result.path, errors: result.errors }
        }).pipe(Effect.mapError((e) => new ApiError({ message: String(e) }))))
      .handle("reviewSkills", () =>
        discoverReviewSkills().pipe(
          Effect.map((skills) =>
            skills.map(({ description, id, name, source }) => ({ id, name, description, source }))
          ),
          Effect.mapError((e) => new ApiError({ message: Predicate.isError(e) ? e.message : String(e) }))
        ))
      .handle("save", ({ payload }) =>
        Effect.gen(function*() {
          const existing = yield* configService.load.pipe(
            Effect.catchIf(() => true, () =>
              Effect.succeed({
                review: ConfigService.defaultReviewConfig,
                sandbox: ConfigService.defaultSandboxConfig
              }))
          )
          const accounts = yield* Effect.forEach(payload.accounts, (a) =>
            Effect.all({
              profile: Schema.decodeEffect(AwsProfileName)(a.profile),
              regions: Effect.forEach(a.regions, (r) => Schema.decodeEffect(AwsRegion)(r)),
              enabled: Effect.succeed(a.enabled)
            }))
          const review = yield* Schema.decodeEffect(ConfigService.ReviewConfig)(payload.review ?? existing.review)
          const outcome = yield* commitConfigMutation(
            configService.save({
              accounts,
              autoDetect: payload.autoDetect,
              autoRefresh: payload.autoRefresh,
              refreshIntervalSeconds: payload.refreshIntervalSeconds,
              review,
              sandbox: payload.sandbox ?? existing.sandbox
            }),
            prService.refresh,
            prService.state,
            "save"
          )
          return outcome.refreshStatus === "failed" ? "saved-refresh-failed" : "saved"
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
          const outcome = yield* commitConfigMutation(
            configService.reset,
            prService.refresh,
            prService.state,
            "reset"
          )
          const config = outcome.value
          const state = yield* SubscriptionRef.get(prService.state)
          return {
            backupPath,
            refreshStatus: outcome.refreshStatus,
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
              review: config.review,
              sandbox: config.sandbox
            }
          }
        }).pipe(Effect.mapError((e) => new ApiError({ message: String(e) }))))
  }))
