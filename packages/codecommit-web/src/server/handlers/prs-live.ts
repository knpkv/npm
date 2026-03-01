import { Command, HttpApiBuilder } from "@effect/platform"
import { AwsClient, CacheService, PRService } from "@knpkv/codecommit-core"
import { encodeCommentLocations } from "@knpkv/codecommit-core/Domain.js"
import { Chunk, Effect, Schema, Stream, SubscriptionRef } from "effect"
import { platform } from "node:os"
import { ApiError, CodeCommitApi } from "../Api.js"

const copyToClipboard = (text: string) => {
  const cmd = platform() === "darwin"
    ? Command.make("pbcopy")
    : Command.make("xclip", "-selection", "clipboard")

  return Command.exitCode(
    Command.stdin(cmd, Stream.make(text).pipe(Stream.encodeText))
  )
}

export const PrsLive = HttpApiBuilder.group(CodeCommitApi, "prs", (handlers) =>
  Effect.gen(function*() {
    const prService = yield* PRService.PRService
    const awsClient = yield* AwsClient.AwsClient
    const notificationRepo = yield* CacheService.NotificationRepo

    return handlers
      .handle("list", () =>
        SubscriptionRef.get(prService.state).pipe(
          Effect.map((state) => Chunk.fromIterable(state.pullRequests))
        ))
      .handle("refresh", () =>
        prService.refresh.pipe(
          Effect.forkDaemon,
          Effect.map(() => "ok")
        ))
      .handle("search", ({ urlParams }) =>
        Effect.gen(function*() {
          const result = yield* prService.searchPullRequests(urlParams.q, {
            limit: urlParams.limit ?? 20,
            offset: urlParams.offset ?? 0
          })
          const items = yield* Effect.forEach(
            result.items,
            (row) => Schema.encode(CacheService.CachedPullRequest)(row)
          )
          return { items, total: result.total, hasMore: result.hasMore }
        }).pipe(Effect.mapError((e) => new ApiError({ message: String(e) }))))
      .handle("refreshSingle", ({ path }) =>
        prService.refreshSinglePR(path.awsAccountId, path.prId).pipe(
          Effect.forkDaemon,
          Effect.map(() => "ok")
        ))
      .handle("create", ({ payload }) =>
        awsClient.createPullRequest({
          account: { profile: payload.account.profile, region: payload.account.region },
          repositoryName: payload.repositoryName,
          title: payload.title,
          ...(payload.description && { description: payload.description }),
          sourceReference: payload.sourceBranch,
          destinationReference: payload.destinationBranch
        }).pipe(
          Effect.mapError((e) => new ApiError({ message: e.message }))
        ))
      .handle("comments", ({ payload }) =>
        awsClient.getCommentsForPullRequest({
          account: { profile: payload.account.profile, region: payload.account.region },
          pullRequestId: payload.pullRequestId,
          repositoryName: payload.repositoryName
        }).pipe(
          Effect.map(encodeCommentLocations),
          Effect.mapError((e) => new ApiError({ message: e.message }))
        ))
      .handle("open", ({ payload }) =>
        Effect.gen(function*() {
          yield* copyToClipboard(payload.link).pipe(
            Effect.catchAll(() => Effect.void)
          )

          yield* notificationRepo.addSystem({
            type: "info",
            title: "Assume",
            message: `Opening ${payload.profile} → PR console...`
          })

          // -c: console login, -d: open URL in default browser
          const cmd = Command.make("assume", "-cd", payload.link, payload.profile).pipe(
            Command.stdout("inherit"),
            Command.stderr("inherit"),
            Command.env({ GRANTED_ALIAS_CONFIGURED: "true" })
          )
          yield* Effect.forkDaemon(
            Command.exitCode(cmd).pipe(
              Effect.tap(() =>
                notificationRepo.addSystem({
                  type: "success",
                  title: "Assume",
                  message: `Assumed ${payload.profile}`
                })
              ),
              Effect.catchAll((e) =>
                notificationRepo.addSystem({
                  type: "error",
                  title: "Assume Failed",
                  message: e instanceof Error ? e.message : String(e)
                })
              )
            )
          )
          return payload.link
        }).pipe(
          Effect.mapError((e) => new ApiError({ message: String(e) }))
        ))
  }))
