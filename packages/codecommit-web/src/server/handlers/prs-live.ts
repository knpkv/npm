import { Command, HttpApiBuilder } from "@effect/platform"
import { AwsClient, PRService } from "@knpkv/codecommit-core"
import { Chunk, Effect, Stream, SubscriptionRef } from "effect"
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
      .handle("create", ({ payload }) =>
        awsClient.createPullRequest({
          account: { profile: payload.account.id, region: payload.account.region },
          repositoryName: payload.repositoryName,
          title: payload.title,
          ...(payload.description && { description: payload.description }),
          sourceReference: payload.sourceBranch,
          destinationReference: payload.destinationBranch
        }).pipe(
          Effect.mapError((e) => new ApiError({ message: e.message }))
        ))
      .handle("open", ({ payload }) =>
        Effect.gen(function*() {
          yield* copyToClipboard(payload.link).pipe(
            Effect.catchAll(() => Effect.void)
          )

          yield* prService.addNotification({
            type: "info",
            title: "Assume",
            message: `URL copied. Running assume -c ${payload.profile}...`
          })

          const cmd = Command.make("assume", "-c", payload.profile).pipe(
            Command.stdout("inherit"),
            Command.stderr("inherit"),
            Command.env({ GRANTED_ALIAS_CONFIGURED: "true" })
          )
          yield* Effect.forkDaemon(
            Command.exitCode(cmd).pipe(
              Effect.tap(() =>
                prService.addNotification({
                  type: "success",
                  title: "Assume",
                  message: `Assumed ${payload.profile}`
                })
              ),
              Effect.catchAll((e) =>
                prService.addNotification({
                  type: "error",
                  title: "Assume Failed",
                  message: e instanceof Error ? e.message : String(e)
                })
              )
            )
          )
          return payload.link
        }).pipe(
          Effect.mapError(() => new ApiError({ message: "Failed to open PR" }))
        ))
  }))
