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
import { AwsClient, CacheService, ChildEnv, PRService, ReadClient } from "@knpkv/codecommit-core"
import type * as Domain from "@knpkv/codecommit-core/Domain.js"
import { encodeCommentLocations } from "@knpkv/codecommit-core/Domain.js"
import { Chunk, Effect, Predicate, Schema, Semaphore, Stream, SubscriptionRef } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { ApiError, CodeCommitApi } from "../Api.js"
import { BackgroundScope } from "../internal/BackgroundScope.js"
import {
  loadPullRequestDiff,
  loadPullRequestDiffContent,
  makePullRequestChangedFilesSource,
  runPullRequestRelayReview,
  withRelayReviewPermit
} from "../review/PullRequestReview.js"

const copyToClipboard = (text: string) => {
  const stdin = Stream.make(text).pipe(Stream.encodeText)
  const copyWith = (cmd: ChildProcess.Command) =>
    Effect.flatMap(ChildProcessSpawner.ChildProcessSpawner, (spawner) => spawner.exitCode(cmd))

  return copyWith(ChildProcess.make("pbcopy", { stdin })).pipe(
    Effect.catchIf(() => true, () => copyWith(ChildProcess.make("xclip", ["-selection", "clipboard"], { stdin })))
  )
}

const extractAwsMessage = (e: unknown): string => {
  if (!Predicate.isObjectKeyword(e)) return String(e)
  // AwsApiError.cause may contain the real AWS exception
  const cause = Predicate.hasProperty(e, "cause") ? e.cause : undefined
  if (Predicate.hasProperty(cause, "message")) {
    return String(cause.message)
  }
  if (Predicate.hasProperty(e, "message") && typeof e.message === "string" && e.message) return e.message
  // PermissionDeniedError or other tagged errors
  if (Predicate.hasProperty(e, "reason")) {
    const operation = Predicate.hasProperty(e, "operation") ? e.operation : "unknown operation"
    return `Permission ${e.reason}: ${operation}`
  }
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

export const selectedPullRequest = (
  pullRequests: ReadonlyArray<Domain.PullRequest>,
  awsAccountId: string,
  pullRequestId: Domain.PullRequestId
): Effect.Effect<Domain.PullRequest, ApiError> => {
  const pullRequest = pullRequests.find(
    (candidate) =>
      candidate.id === pullRequestId &&
      (candidate.account.awsAccountId === awsAccountId ||
        candidate.account.repoAccountId === awsAccountId ||
        candidate.account.profile === awsAccountId)
  )
  return pullRequest === undefined
    ? Effect.fail(new ApiError({ message: "The selected pull request is not available in the local workspace" }))
    : Effect.succeed(pullRequest)
}

export const PrsLive = HttpApiBuilder.group(CodeCommitApi, "prs", (handlers) =>
  Effect.gen(function*() {
    const prService = yield* PRService.PRService
    const awsClient = yield* AwsClient.AwsClient
    const readClient = yield* ReadClient.CodeCommitReadClient
    const changedFiles = yield* makePullRequestChangedFilesSource(readClient)
    const relaySemaphore = yield* Semaphore.make(1)
    const notificationRepo = yield* CacheService.NotificationRepo
    const ownerScope = yield* BackgroundScope
    // A process-wide environment snapshot is a stable application service, not a
    // request-scoped one: acquiring it here keeps this group's layer closed over its
    // own requirements instead of leaking them into every consumer of HandlersLive.
    const host = yield* ChildEnv.HostEnvironment

    return handlers
      .handle("list", () =>
        SubscriptionRef.get(prService.state).pipe(
          Effect.map((state) => Chunk.fromIterable(state.pullRequests))
        ))
      .handle("refresh", () =>
        prService.refresh.pipe(
          Effect.forkIn(ownerScope),
          Effect.map(() => "ok")
        ))
      .handle("search", ({ query }) =>
        Effect.gen(function*() {
          const result = yield* prService.searchPullRequests(query.q, {
            limit: query.limit ?? 20,
            offset: query.offset ?? 0
          })
          const items = yield* Effect.forEach(
            result.items,
            (row) => Schema.encodeEffect(CacheService.CachedPullRequest)(row)
          )
          return { items, total: result.total, hasMore: result.hasMore }
        }).pipe(Effect.mapError((e) => new ApiError({ message: String(e) }))))
      .handle("refreshSingle", ({ params }) =>
        prService.refreshSinglePR(params.awsAccountId, params.prId).pipe(
          Effect.forkIn(ownerScope),
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
      .handle("comments", ({ query }) =>
        awsClient.getCommentsForPullRequest({
          account: { profile: query.profile, region: query.region },
          pullRequestId: query.pullRequestId,
          repositoryName: query.repositoryName
        }).pipe(
          Effect.map(encodeCommentLocations),
          Effect.mapError((e) => new ApiError({ message: e.message }))
        ))
      .handle("diff", ({ params }) =>
        Effect.gen(function*() {
          const state = yield* SubscriptionRef.get(prService.state)
          const pullRequest = yield* selectedPullRequest(state.pullRequests, params.awsAccountId, params.prId)
          return yield* loadPullRequestDiff(readClient, pullRequest, changedFiles)
        }).pipe(Effect.mapError((error) => new ApiError({ message: error.message }))))
      .handle("diffContent", ({ params, query }) =>
        Effect.gen(function*() {
          const state = yield* SubscriptionRef.get(prService.state)
          const pullRequest = yield* selectedPullRequest(state.pullRequests, params.awsAccountId, params.prId)
          return yield* loadPullRequestDiffContent(
            readClient,
            pullRequest,
            query.revisionId,
            params.fileIndex,
            changedFiles
          )
        }).pipe(Effect.mapError((error) => new ApiError({ message: error.message }))))
      .handle("relayReview", ({ params, payload }) =>
        Effect.gen(function*() {
          const state = yield* SubscriptionRef.get(prService.state)
          const pullRequest = yield* selectedPullRequest(state.pullRequests, params.awsAccountId, params.prId)
          return yield* withRelayReviewPermit(
            relaySemaphore,
            runPullRequestRelayReview(
              readClient,
              pullRequest,
              payload.revisionId,
              payload.kind,
              changedFiles
            )
          )
        }).pipe(Effect.mapError((error) => new ApiError({ message: error.message }))))
      .handle("open", ({ payload }) =>
        Effect.gen(function*() {
          yield* copyToClipboard(payload.link).pipe(
            Effect.catchIf(() => true, () => Effect.void)
          )

          // -c: console login, -d: open URL in default browser
          const cmd = ChildProcess.make("assume", ["-cd", payload.link, payload.profile], {
            stdout: "inherit",
            stderr: "inherit",
            // `assume` is resolved from PATH and needs the caller's AWS/SSO env, so the
            // flag must be merged into the inherited environment. The profile argument
            // stays authoritative only if ambient AWS credentials are dropped.
            env: ChildEnv.profileScopedEnv(host.variables, { GRANTED_ALIAS_CONFIGURED: "true" }),
            extendEnv: true
          })
          yield* Effect.forkIn(
            Effect.flatMap(ChildProcessSpawner.ChildProcessSpawner, (spawner) => spawner.exitCode(cmd)).pipe(
              Effect.catchIf(() => true, (e) =>
                notificationRepo.addSystem({
                  type: "error",
                  title: "Assume Failed",
                  message: Predicate.isError(e) ? e.message : String(e)
                }))
            ),
            ownerScope
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
