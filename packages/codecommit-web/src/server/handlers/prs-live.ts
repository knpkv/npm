/**
 * PR endpoint handlers — list, refresh, create, open, comments, approval rules.
 *
 * Handles PR CRUD (list, search, refresh, create, open in console via Granted),
 * comments fetch, and approval rule management (create/update/delete).
 * {@link buildApprovalRuleContent} constructs the AWS JSON format
 * `{Version, Statements, ApprovalPoolMembers}`. {@link extractAwsMessage}
 * drills into AwsApiError.cause.message for human-readable error text.
 * Approval rule errors produce system notifications via tapError.
 *
 * @module
 */
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

const extractAwsMessage = (e: unknown): string => {
  if (!e || typeof e !== "object") return String(e)
  const err = e as Record<string, unknown>
  // AwsApiError.cause may contain the real AWS exception
  const cause = err.cause
  if (cause && typeof cause === "object" && "message" in cause) {
    return String((cause as Record<string, unknown>).message)
  }
  if ("message" in err && typeof err.message === "string" && err.message) return err.message
  // PermissionDeniedError or other tagged errors
  if ("reason" in err) return `Permission ${err.reason}: ${err.operation ?? "unknown operation"}`
  try {
    return JSON.stringify(e)
  } catch {
    return String(e)
  }
}

const buildApprovalRuleContent = (requiredApprovals: number, poolMembers: ReadonlyArray<string>) =>
  JSON.stringify({
    Version: "2018-11-08",
    Statements: [{
      Type: "Approvers",
      NumberOfApprovalsNeeded: requiredApprovals,
      ApprovalPoolMembers: poolMembers
    }]
  })

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
      .handle("comments", ({ urlParams }) =>
        awsClient.getCommentsForPullRequest({
          account: { profile: urlParams.profile, region: urlParams.region },
          pullRequestId: urlParams.pullRequestId,
          repositoryName: urlParams.repositoryName
        }).pipe(
          Effect.map(encodeCommentLocations),
          Effect.mapError((e) => new ApiError({ message: e.message }))
        ))
      .handle("open", ({ payload }) =>
        Effect.gen(function*() {
          yield* copyToClipboard(payload.link).pipe(
            Effect.catchAll(() => Effect.void)
          )

          // -c: console login, -d: open URL in default browser
          const cmd = Command.make("assume", "-cd", payload.link, payload.profile).pipe(
            Command.stdout("inherit"),
            Command.stderr("inherit"),
            Command.env({ GRANTED_ALIAS_CONFIGURED: "true" })
          )
          yield* Effect.forkDaemon(
            Command.exitCode(cmd).pipe(
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
      .handle("createApprovalRule", ({ payload }) =>
        awsClient.createApprovalRule({
          account: { profile: payload.account.profile, region: payload.account.region },
          pullRequestId: payload.pullRequestId,
          approvalRuleName: payload.approvalRuleName,
          approvalRuleContent: buildApprovalRuleContent(payload.requiredApprovals, payload.poolMembers)
        }).pipe(
          Effect.map(() => "ok"),
          Effect.tapError((e) =>
            notificationRepo.addSystem({
              type: "error",
              title: "Approval Rule",
              message: extractAwsMessage(e)
            })
          ),
          Effect.mapError((e) => new ApiError({ message: e.message }))
        ))
      .handle("updateApprovalRule", ({ payload }) =>
        awsClient.updateApprovalRule({
          account: { profile: payload.account.profile, region: payload.account.region },
          pullRequestId: payload.pullRequestId,
          approvalRuleName: payload.approvalRuleName,
          newApprovalRuleContent: buildApprovalRuleContent(payload.requiredApprovals, payload.poolMembers)
        }).pipe(
          Effect.map(() => "ok"),
          Effect.tapError((e) =>
            notificationRepo.addSystem({
              type: "error",
              title: "Approval Rule",
              message: extractAwsMessage(e)
            })
          ),
          Effect.mapError((e) => new ApiError({ message: e.message }))
        ))
      .handle("deleteApprovalRule", ({ payload }) =>
        awsClient.deleteApprovalRule({
          account: { profile: payload.account.profile, region: payload.account.region },
          pullRequestId: payload.pullRequestId,
          approvalRuleName: payload.approvalRuleName
        }).pipe(
          Effect.map(() => "ok"),
          Effect.tapError((e) =>
            notificationRepo.addSystem({
              type: "error",
              title: "Approval Rule",
              message: extractAwsMessage(e)
            })
          ),
          Effect.mapError((e) => new ApiError({ message: e.message }))
        ))
  }))
