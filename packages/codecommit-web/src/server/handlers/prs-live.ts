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
import { AwsClient, CacheService, ChildEnv, ConfigService, PRService, ReadClient } from "@knpkv/codecommit-core"
import type { PullRequestRepoContract } from "@knpkv/codecommit-core/CacheService/repos/PullRequestRepo/index.js"
import * as Domain from "@knpkv/codecommit-core/Domain.js"
import { encodeCommentLocations } from "@knpkv/codecommit-core/Domain.js"
import type { RefreshSinglePRCoordinates } from "@knpkv/codecommit-core/PRService/index.js"
import { Chunk, Effect, Option, Predicate, Schema, Semaphore, Stream, SubscriptionRef } from "effect"
import * as FileSystem from "effect/FileSystem"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { decodePullRequestCoordinates } from "../../pull-request-coordinates.js"
import type { PullRequestCoordinates } from "../../pull-request-coordinates.js"
import {
  ApiError,
  CodeCommitApi,
  type PullRequestDiffContentResponse,
  type PullRequestRefreshResponse,
  RelayReviewContinueStreamRequest,
  type RelayReviewProfile,
  RelayReviewStreamEvent,
  RelayReviewStreamRequest
} from "../Api.js"
import { BackgroundScope } from "../internal/BackgroundScope.js"
import {
  loadPullRequestDiff,
  loadPullRequestDiffContent,
  makePullRequestChangedFilesSource,
  postPullRequestRelayFinding,
  runPullRequestRelayReview,
  streamPullRequestRelayConversation,
  streamPullRequestRelayReview,
  withRelayReviewPermit,
  withRelayReviewStreamPermit
} from "../review/PullRequestReview.js"
import { RelayFindingPublisher } from "../review/RelayFindingPublisher.js"
import {
  discoverReviewSkills,
  type ReviewSkillDefinition,
  selectedReviewSkillPrompt
} from "../review/ReviewSkillCatalog.js"

const copyToClipboard = (text: string) => {
  const stdin = Stream.make(text).pipe(Stream.encodeText)
  const copyWith = (cmd: ChildProcess.Command) =>
    Effect.flatMap(ChildProcessSpawner.ChildProcessSpawner, (spawner) => spawner.exitCode(cmd))

  return copyWith(ChildProcess.make("pbcopy", { stdin })).pipe(
    Effect.catchIf(() => true, () => copyWith(ChildProcess.make("xclip", ["-selection", "clipboard"], { stdin })))
  )
}

const extractAwsMessage = <Failure>(e: Failure): string => {
  if (!Predicate.isObjectKeyword(e)) return String(e)
  // AwsApiError.cause may contain the real AWS exception
  const cause = Predicate.hasProperty(e, "cause") ? e.cause : undefined
  if (Predicate.hasProperty(cause, "message")) {
    return String(cause.message)
  }
  if (Predicate.hasProperty(e, "message") && Predicate.isString(e.message) && e.message.length > 0) return e.message
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

const relayEventEncoder = new TextEncoder()
const encodeRelayStreamEvent = Schema.encodeSync(Schema.fromJsonString(RelayReviewStreamEvent))
const relayReviewMarker = /\n\n<!-- knpkv-codecommit-review:[0-9a-f]{64} -->$/u
const sameReviewProfile = Schema.toEquivalence(ConfigService.ReviewProfileConfig)

/** Resolve only an exact saved profile snapshot; stale or forged execution fields fail closed. */
export const resolveRelayReviewProfile = Effect.fn("PrsLive.resolveRelayReviewProfile")(function*(
  configService: Pick<ConfigService.ConfigService["Service"], "load">,
  requested: RelayReviewProfile
) {
  const config = yield* configService.load.pipe(
    Effect.mapError(() => new ApiError({ message: "Relay profiles are unavailable" }))
  )
  const configured = config.review.profiles.find(({ id }) => id === requested.id)
  if (configured === undefined || !sameReviewProfile(configured, requested)) {
    return yield* new ApiError({ message: "The selected Relay profile is unknown or has changed; reload settings" })
  }
  return configured
})

/** Resolve one server-owned profile and its catalog-owned prompt as one execution configuration. */
export const resolveRelayReviewExecution = Effect.fn("PrsLive.resolveRelayReviewExecution")(function*(
  configService: Pick<ConfigService.ConfigService["Service"], "load">,
  requested: RelayReviewProfile,
  skills: ReadonlyArray<ReviewSkillDefinition>
) {
  const profile = yield* resolveRelayReviewProfile(configService, requested)
  const skillPrompt = yield* selectedReviewSkillPrompt(skills, profile.skillIds)
  return { profile, skillPrompt }
})

const stripRelayReviewMarker = (content: string): string => content.replace(relayReviewMarker, "")

const sanitizeCommentThread = (thread: Domain.CommentThreadJsonEncoded): Domain.CommentThreadJsonEncoded => ({
  root: { ...thread.root, content: stripRelayReviewMarker(thread.root.content) },
  replies: thread.replies.map(sanitizeCommentThread)
})

/** Encode provider comments without server-private Relay reconciliation markers. */
export const encodeClientVisibleCommentLocations = (
  locations: ReadonlyArray<Domain.PRCommentLocation>
): ReturnType<typeof encodeCommentLocations> =>
  encodeCommentLocations(locations).map((location) => ({
    ...location,
    comments: location.comments.map(sanitizeCommentThread)
  }))

const relayStreamResponse = (stream: Stream.Stream<typeof RelayReviewStreamEvent.Type>) =>
  HttpServerResponse.stream(
    stream.pipe(
      Stream.map((event) => relayEventEncoder.encode(`${encodeRelayStreamEvent(event)}\n`))
    ),
    {
      headers: {
        "content-type": "application/x-ndjson; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff"
      }
    }
  )

export const selectedPullRequest = (
  pullRequests: ReadonlyArray<Domain.PullRequest>,
  awsAccountId: string,
  pullRequestId: Domain.PullRequestId,
  coordinates?: PullRequestSelectionCoordinates
): Effect.Effect<Domain.PullRequest, ApiError> => {
  const routeAccountId = coordinates?.accountId ?? awsAccountId
  const accountMatches = (candidate: Domain.PullRequest): boolean =>
    coordinates === undefined
      ? candidate.account.awsAccountId === routeAccountId
        || candidate.account.repoAccountId === routeAccountId
        || candidate.account.profile === routeAccountId
      : candidate.account.awsAccountId !== undefined && candidate.account.awsAccountId !== ""
      ? candidate.account.awsAccountId === routeAccountId
      : candidate.account.repoAccountId === routeAccountId || candidate.account.profile === routeAccountId
  const matches = pullRequests.filter(
    (candidate) =>
      candidate.id === pullRequestId &&
      accountMatches(candidate) &&
      (coordinates === undefined ||
        (candidate.repositoryName === coordinates.repositoryName && candidate.account.region === coordinates.region))
  )
  if (matches.length === 1) {
    const pullRequest = matches[0]
    return pullRequest === undefined
      ? Effect.fail(new ApiError({ message: "The selected pull request is not available in the local workspace" }))
      : Effect.succeed(pullRequest)
  }
  return Effect.fail(
    new ApiError({
      message: matches.length === 0
        ? "The selected pull request is not available in the local workspace"
        : "The selected pull request is ambiguous; repository and region coordinates are required"
    })
  )
}

interface PullRequestLookup {
  readonly findAll: PullRequestRepoContract["findAll"]
}

interface PullRequestSelectionCoordinates {
  readonly accountId?: string
  readonly repositoryName: string
  readonly region: string
}

/** Resolve the same durable PR row used by SSE before enforcing the route account boundary. */
export const cachedPullRequest = (
  pullRequestRepo: PullRequestLookup,
  awsAccountId: string,
  pullRequestId: Domain.PullRequestId,
  directCoordinates?: PullRequestSelectionCoordinates
): Effect.Effect<Domain.PullRequest, ApiError> => {
  const coordinatesEffect = decodePullRequestCoordinates(awsAccountId).pipe(
    Effect.mapError((error) => new ApiError({ message: error.message })),
    Effect.flatMap((token) => {
      if (Option.isSome(token)) {
        if (token.value.pullRequestId !== pullRequestId) {
          return Effect.fail(new ApiError({ message: "The pull-request coordinate token does not match its route" }))
        }
        if (
          directCoordinates !== undefined &&
          (token.value.repositoryName !== directCoordinates.repositoryName ||
            token.value.region !== directCoordinates.region)
        ) {
          return Effect.fail(new ApiError({ message: "The pull-request coordinates do not match its route" }))
        }
        return Effect.succeed(token)
      }
      return directCoordinates === undefined
        ? Effect.succeed(Option.none<PullRequestCoordinates>())
        : Effect.succeed(Option.some<PullRequestCoordinates>({
          accountId: awsAccountId,
          pullRequestId,
          repositoryName: Domain.RepositoryName.make(directCoordinates.repositoryName),
          region: Domain.AwsRegion.make(directCoordinates.region)
        }))
    })
  )
  return coordinatesEffect.pipe(
    Effect.flatMap((coordinatesOption) => {
      const coordinates = Option.getOrUndefined(coordinatesOption)
      return pullRequestRepo.findAll().pipe(
        Effect.map((rows) => rows.map((row) => PRService.decodeCachedPR(row))),
        Effect.mapError(() =>
          new ApiError({ message: "The selected pull request is not available in the local workspace" })
        ),
        Effect.flatMap((pullRequests) =>
          selectedPullRequest(
            pullRequests,
            coordinates?.accountId ?? awsAccountId,
            pullRequestId,
            coordinates
          )
        )
      )
    })
  )
}

/** Keep proprietary source revisions out of browser and intermediary caches. */
export const makeDiffContentResponse = (content: PullRequestDiffContentResponse) =>
  HttpServerResponse.json(content, {
    headers: { "cache-control": "no-store" }
  }).pipe(Effect.mapError((error) => new ApiError({ message: error.message })))

/** Complete a durable single-PR refresh and return its immutable provider revision identity. */
export const completeSinglePullRequestRefresh = <E, R>(
  refresh: Effect.Effect<PRService.RefreshSinglePRResult, E, R>
): Effect.Effect<PullRequestRefreshResponse, E, R> =>
  refresh.pipe(
    Effect.map(({ revisionId, sourceCommit }) => ({ revisionId, headCommit: sourceCommit }))
  )

export const refreshRouteCoordinates = (
  accountId: string,
  pullRequestId: Domain.PullRequestId,
  query: {
    readonly repositoryName?: string | undefined
    readonly region?: Domain.AwsRegion | undefined
  }
): Effect.Effect<
  { readonly accountId: string; readonly coordinates?: RefreshSinglePRCoordinates },
  ApiError
> =>
  Effect.gen(function*() {
    const token = yield* decodePullRequestCoordinates(accountId).pipe(
      Effect.mapError((error) => new ApiError({ message: error.message }))
    )
    if (Option.isSome(token)) {
      if (token.value.pullRequestId !== pullRequestId) {
        return yield* new ApiError({ message: "The pull-request coordinate token does not match its route" })
      }
      return {
        accountId: token.value.accountId,
        coordinates: {
          repositoryName: token.value.repositoryName,
          region: token.value.region,
          accountIdSource: "coordinate-token"
        }
      }
    }
    if (query.repositoryName === undefined && query.region === undefined) return { accountId }
    if (query.repositoryName === undefined || query.region === undefined) {
      return yield* new ApiError({ message: "Pull-request refresh coordinates require repository and region together" })
    }
    const repositoryName = yield* Schema.decodeUnknownEffect(Domain.RepositoryName)(query.repositoryName).pipe(
      Effect.mapError(() => new ApiError({ message: "Invalid pull-request repository coordinate" }))
    )
    return {
      accountId,
      coordinates: {
        repositoryName,
        region: query.region
      }
    }
  })

export const PrsLive = HttpApiBuilder.group(CodeCommitApi, "prs", (handlers) =>
  Effect.gen(function*() {
    const prService = yield* PRService.PRService
    const awsClient = yield* AwsClient.AwsClient
    const readClient = yield* ReadClient.CodeCommitReadClient
    const pullRequestRepo = yield* CacheService.PullRequestRepo
    const changedFiles = yield* makePullRequestChangedFilesSource(readClient)
    const relaySemaphore = yield* Semaphore.make(1)
    const notificationRepo = yield* CacheService.NotificationRepo
    const ownerScope = yield* BackgroundScope
    // A process-wide environment snapshot is a stable application service, not a
    // request-scoped one: acquiring it here keeps this group's layer closed over its
    // own requirements instead of leaking them into every consumer of HandlersLive.
    const host = yield* ChildEnv.HostEnvironment
    const fileSystem = yield* FileSystem.FileSystem
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const relayFindingPublisher = yield* RelayFindingPublisher
    const configService = yield* ConfigService.ConfigService

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
      .handle("refreshSingle", ({ params, query }) =>
        Effect.gen(function*() {
          const route = yield* refreshRouteCoordinates(params.awsAccountId, params.prId, query)
          return yield* completeSinglePullRequestRefresh(
            prService.refreshSinglePR(route.accountId, params.prId, route.coordinates)
          )
        }).pipe(
          Effect.mapError((error) =>
            Predicate.isTagged(error, "ApiError") ? error : new ApiError({ message: extractAwsMessage(error) })
          )
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
          Effect.map(encodeClientVisibleCommentLocations),
          Effect.mapError((e) => new ApiError({ message: e.message }))
        ))
      .handle("diff", ({ params, query }) =>
        Effect.gen(function*() {
          const pullRequest = yield* cachedPullRequest(pullRequestRepo, params.awsAccountId, params.prId, query)
          return yield* loadPullRequestDiff(readClient, pullRequest, changedFiles)
        }).pipe(Effect.mapError((error) => new ApiError({ message: error.message }))))
      .handleRaw("diffContent", ({ params, query }) =>
        Effect.gen(function*() {
          const pullRequest = yield* cachedPullRequest(pullRequestRepo, params.awsAccountId, params.prId, query)
          const content = yield* loadPullRequestDiffContent(
            readClient,
            pullRequest,
            query,
            params.fileIndex,
            changedFiles
          )
          return yield* makeDiffContentResponse(content)
        }).pipe(Effect.mapError((error) => new ApiError({ message: error.message }))))
      .handle("relayReview", ({ params, payload, query }) =>
        Effect.gen(function*() {
          const skills = yield* discoverReviewSkills()
          const { profile, skillPrompt } = yield* resolveRelayReviewExecution(configService, payload.profile, skills)
          const pullRequest = yield* cachedPullRequest(pullRequestRepo, params.awsAccountId, params.prId, query)
          return yield* withRelayReviewPermit(
            relaySemaphore,
            runPullRequestRelayReview(
              readClient,
              pullRequest,
              payload,
              profile,
              changedFiles,
              skillPrompt
            )
          )
        }).pipe(Effect.mapError((error) => new ApiError({ message: error.message }))))
      .handleRaw("relayReviewStream", ({ params, query }) =>
        Effect.gen(function*() {
          const payload = yield* HttpServerRequest.schemaBodyJson(RelayReviewStreamRequest)
          const skills = yield* discoverReviewSkills()
          const { profile, skillPrompt } = yield* resolveRelayReviewExecution(configService, payload.profile, skills)
          const pullRequest = yield* cachedPullRequest(pullRequestRepo, params.awsAccountId, params.prId, query)
          const stream = withRelayReviewStreamPermit(
            relaySemaphore,
            streamPullRequestRelayReview(
              readClient,
              pullRequest,
              payload,
              profile,
              changedFiles,
              skillPrompt
            )
          ).pipe(
            Stream.catch((error) => Stream.make({ type: "error", message: error.message }))
          )
          return relayStreamResponse(stream.pipe(
            Stream.provideService(FileSystem.FileSystem, fileSystem),
            Stream.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner)
          ))
        }).pipe(
          Effect.mapError((error) =>
            new ApiError({ message: Predicate.isError(error) ? error.message : String(error) })
          )
        ))
      .handleRaw("relayReviewContinueStream", ({ params, query }) =>
        Effect.gen(function*() {
          const payload = yield* HttpServerRequest.schemaBodyJson(RelayReviewContinueStreamRequest)
          const skills = yield* discoverReviewSkills()
          const { profile, skillPrompt } = yield* resolveRelayReviewExecution(configService, payload.profile, skills)
          const pullRequest = yield* cachedPullRequest(pullRequestRepo, params.awsAccountId, params.prId, query)
          const stream = withRelayReviewStreamPermit(
            relaySemaphore,
            streamPullRequestRelayConversation(
              readClient,
              pullRequest,
              payload,
              profile,
              payload.currentReview,
              payload.turns,
              payload.findingId,
              payload.message,
              changedFiles,
              skillPrompt
            )
          ).pipe(
            Stream.catch((error) => Stream.make({ type: "error", message: error.message }))
          )
          return relayStreamResponse(stream.pipe(
            Stream.provideService(FileSystem.FileSystem, fileSystem),
            Stream.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner)
          ))
        }).pipe(
          Effect.mapError((error) =>
            new ApiError({ message: Predicate.isError(error) ? error.message : String(error) })
          )
        ))
      .handle("postRelayFinding", ({ params, payload, query }) =>
        Effect.gen(function*() {
          if (payload.finding.id !== params.findingId) {
            return yield* new ApiError({ message: "The finding route does not match the submitted finding" })
          }
          const pullRequest = yield* cachedPullRequest(pullRequestRepo, params.awsAccountId, params.prId, query)
          return yield* postPullRequestRelayFinding(
            readClient,
            relayFindingPublisher,
            pullRequest,
            payload,
            payload.finding,
            changedFiles
          )
        }).pipe(Effect.mapError((error) =>
          Predicate.isTagged(error, "ApiError")
            ? error
            : new ApiError({ message: Predicate.hasProperty(error, "message") ? String(error.message) : String(error) })
        )))
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
