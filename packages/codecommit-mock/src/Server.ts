import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer"
import { codecommitConsoleUrl } from "@knpkv/codecommit-core/Domain.js"
import * as Context from "effect/Context"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"
import * as Scope from "effect/Scope"
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { createServer } from "node:http"

import type { CodeCommitMockScenario } from "./Scenario.js"
import {
  activeRevision,
  type CodeCommitMockState,
  findPullRequest,
  makeInitialState,
  type MockComment,
  recordRequest
} from "./State.js"

class MockOperationError extends Data.TaggedError("MockOperationError")<{
  readonly awsTag: string
  readonly message: string
  readonly status: number
}> {}

/** Failure to validate or bind a mock instance. */
export class CodeCommitMockStartupError extends Data.TaggedError("CodeCommitMockStartupError")<{
  readonly cause: unknown
}> {}

const requiredString = Schema.String.check(Schema.isNonEmpty())
const PullRequestInput = Schema.Struct({ pullRequestId: requiredString })
const RepositoryInput = Schema.Struct({ repositoryName: requiredString })
const ListPullRequestsInput = Schema.Struct({
  repositoryName: requiredString,
  pullRequestStatus: Schema.optional(Schema.Literals(["OPEN", "CLOSED"])),
  authorArn: Schema.optional(Schema.String),
  nextToken: Schema.optional(Schema.String),
  maxResults: Schema.optional(Schema.Number)
})
const GetDifferencesInput = Schema.Struct({
  repositoryName: requiredString,
  beforeCommitSpecifier: Schema.optional(Schema.String),
  afterCommitSpecifier: requiredString,
  beforePath: Schema.optional(Schema.String),
  afterPath: Schema.optional(Schema.String),
  MaxResults: Schema.optional(Schema.Number),
  NextToken: Schema.optional(Schema.String)
})
const GetBlobInput = Schema.Struct({ repositoryName: requiredString, blobId: requiredString })
const ReviewTargetInput = Schema.Struct({
  pullRequestId: requiredString,
  repositoryName: Schema.optional(Schema.String),
  beforeCommitId: Schema.optional(Schema.String),
  afterCommitId: Schema.optional(Schema.String),
  nextToken: Schema.optional(Schema.String),
  maxResults: Schema.optional(Schema.Number)
})
const LocationInput = Schema.Struct({
  filePath: Schema.optional(Schema.String),
  filePosition: Schema.optional(Schema.Number),
  relativeFileVersion: Schema.optional(Schema.String)
})
const PostCommentInput = Schema.Struct({
  pullRequestId: requiredString,
  repositoryName: requiredString,
  beforeCommitId: requiredString,
  afterCommitId: requiredString,
  content: Schema.String,
  clientRequestToken: Schema.optional(Schema.String),
  location: Schema.optional(LocationInput)
})
const UpdateCommentInput = Schema.Struct({ commentId: requiredString, content: Schema.String })
const PostReplyInput = Schema.Struct({
  inReplyTo: requiredString,
  content: Schema.String,
  clientRequestToken: Schema.optional(Schema.String)
})
const ApprovalInput = Schema.Struct({
  pullRequestId: requiredString,
  revisionId: requiredString,
  approvalState: Schema.Literals(["APPROVE", "REVOKE"])
})
const RevisionInput = Schema.Struct({ pullRequestId: requiredString, revisionId: requiredString })
const MergeConflictsInput = Schema.Struct({
  repositoryName: requiredString,
  destinationCommitSpecifier: requiredString,
  sourceCommitSpecifier: requiredString,
  mergeOption: requiredString
})
const AdminPushInput = Schema.Struct({ pullRequestId: requiredString })
const AdminCommentInput = Schema.Struct({
  pullRequestId: requiredString,
  content: Schema.String.check(Schema.isNonEmpty()),
  authorArn: Schema.optional(requiredString)
})

const decode = <S extends Schema.Constraint>(schema: S, input: Schema.Json) =>
  Schema.decodeUnknownEffect(schema)(input).pipe(
    Effect.mapError(() =>
      new MockOperationError({
        awsTag: "InvalidRequestException",
        message: "request does not match the mock operation contract",
        status: 400
      })
    )
  )

const missingPullRequest = (pullRequestId: string) =>
  new MockOperationError({
    awsTag: "PullRequestDoesNotExistException",
    message: `pull request ${pullRequestId} does not exist`,
    status: 400
  })

const missingRepository = (repositoryName: string) =>
  new MockOperationError({
    awsTag: "RepositoryDoesNotExistException",
    message: `repository ${repositoryName} does not exist`,
    status: 400
  })

const commentOutput = (comment: MockComment) => ({
  commentId: comment.commentId,
  content: comment.content,
  creationDate: comment.creationEpochSeconds,
  lastModifiedDate: comment.creationEpochSeconds,
  authorArn: comment.authorArn,
  deleted: false,
  ...(!(comment.clientRequestToken === null) && { clientRequestToken: comment.clientRequestToken }),
  ...(!(comment.inReplyTo === null) && { inReplyTo: comment.inReplyTo })
})

const commitTupleMismatch = (beforeCommitId: string, afterCommitId: string) =>
  new MockOperationError({
    awsTag: "CommitDoesNotExistException",
    message: `revision ${beforeCommitId}..${afterCommitId} does not exist`,
    status: 400
  })

const idempotencyMismatch = (clientRequestToken: string) =>
  new MockOperationError({
    awsTag: "IdempotencyParameterMismatchException",
    message: `client request token ${clientRequestToken} was reused with different parameters`,
    status: 400
  })

const optionalLocation = (location: typeof LocationInput.Type | undefined) =>
  location === undefined
    ? null
    : {
      ...(!(location.filePath === undefined) && { filePath: location.filePath }),
      ...(!(location.filePosition === undefined) && { filePosition: location.filePosition }),
      ...(!(location.relativeFileVersion === undefined) && {
        relativeFileVersion: location.relativeFileVersion
      })
    }

const locationsEqual = (
  left: MockComment["location"],
  right: MockComment["location"]
): boolean =>
  left === null || right === null
    ? left === right
    : left.filePath === right.filePath &&
      left.filePosition === right.filePosition &&
      left.relativeFileVersion === right.relativeFileVersion

const pullRequestOutput = (state: CodeCommitMockState, pullRequestId: string) => {
  const found = findPullRequest(state, pullRequestId)
  if (found === null) return Effect.fail(missingPullRequest(pullRequestId))
  const revision = activeRevision(state, found.pullRequest)
  return Effect.succeed({
    pullRequest: {
      pullRequestId: found.pullRequest.pullRequestId,
      title: found.pullRequest.title,
      description: found.pullRequest.description,
      lastActivityDate: revision.activityEpochSeconds,
      creationDate: found.pullRequest.creationEpochSeconds,
      pullRequestStatus: found.pullRequest.status,
      authorArn: found.pullRequest.authorArn,
      revisionId: revision.revisionId,
      pullRequestTargets: [{
        repositoryName: found.repositoryName,
        sourceReference: found.pullRequest.sourceReference,
        destinationReference: found.pullRequest.destinationReference,
        sourceCommit: revision.sourceCommit,
        destinationCommit: revision.destinationCommit,
        mergeBase: revision.mergeBase,
        mergeMetadata: { isMerged: false }
      }],
      approvalRules: []
    }
  })
}

const makeCommentGroup = (
  root: MockComment,
  comments: ReadonlyArray<MockComment>
) => {
  const descendants = (parentId: string): ReadonlyArray<MockComment> =>
    comments
      .filter((comment) => comment.inReplyTo === parentId)
      .flatMap((comment) => [comment, ...descendants(comment.commentId)])

  return {
    pullRequestId: root.pullRequestId,
    repositoryName: root.repositoryName,
    beforeCommitId: root.beforeCommitId,
    afterCommitId: root.afterCommitId,
    ...(!(root.location === null) && { location: root.location }),
    comments: [root, ...descendants(root.commentId)].map(commentOutput)
  }
}

type CommentWriteOutcome =
  | { readonly _tag: "inserted" | "replayed"; readonly comment: MockComment }
  | { readonly _tag: "mismatch"; readonly clientRequestToken: string }
  | { readonly _tag: "missing-parent"; readonly commentId: string }
type RootCommentWriteOutcome = Exclude<CommentWriteOutcome, { readonly _tag: "missing-parent" }>

const handleOperation = (
  stateRef: Ref.Ref<CodeCommitMockState>,
  operation: string,
  rawInput: Schema.Json
): Effect.Effect<Schema.Json, MockOperationError> =>
  Effect.gen(function*() {
    yield* recordRequest(stateRef, operation, rawInput)
    const state = yield* Ref.get(stateRef)

    switch (operation) {
      case "ListRepositories":
        return {
          repositories: state.scenario.repositories.map((repository) => ({
            repositoryName: repository.repositoryName,
            repositoryId: repository.repositoryId
          }))
        }
      case "GetRepository": {
        const input = yield* decode(RepositoryInput, rawInput)
        const repository = state.scenario.repositories.find(
          (candidate) => candidate.repositoryName === input.repositoryName
        )
        if (repository === undefined) return yield* missingRepository(input.repositoryName)
        return {
          repositoryMetadata: {
            accountId: state.scenario.accountId,
            repositoryId: repository.repositoryId,
            repositoryName: repository.repositoryName,
            repositoryDescription: repository.description,
            defaultBranch: repository.defaultBranch,
            Arn: `arn:aws:codecommit:${state.scenario.region}:${state.scenario.accountId}:${repository.repositoryName}`
          }
        }
      }
      case "ListPullRequests": {
        const input = yield* decode(ListPullRequestsInput, rawInput)
        const repository = state.scenario.repositories.find(
          (candidate) => candidate.repositoryName === input.repositoryName
        )
        if (repository === undefined) return yield* missingRepository(input.repositoryName)
        return {
          pullRequestIds: repository.pullRequests
            .filter((pullRequest) =>
              input.pullRequestStatus === undefined || pullRequest.status === input.pullRequestStatus
            )
            .filter((pullRequest) => input.authorArn === undefined || pullRequest.authorArn === input.authorArn)
            .map((pullRequest) => pullRequest.pullRequestId)
        }
      }
      case "GetPullRequest": {
        const input = yield* decode(PullRequestInput, rawInput)
        return yield* pullRequestOutput(state, input.pullRequestId)
      }
      case "GetDifferences": {
        const input = yield* decode(GetDifferencesInput, rawInput)
        const repository = state.scenario.repositories.find(
          (candidate) => candidate.repositoryName === input.repositoryName
        )
        if (repository === undefined) return yield* missingRepository(input.repositoryName)
        const revision = repository.pullRequests
          .flatMap((pullRequest) => pullRequest.revisions)
          .find((candidate) =>
            candidate.sourceCommit === input.afterCommitSpecifier &&
            (input.beforeCommitSpecifier === undefined ||
              candidate.destinationCommit === input.beforeCommitSpecifier ||
              candidate.mergeBase === input.beforeCommitSpecifier)
          )
        if (revision === undefined) {
          return yield* commitTupleMismatch(
            input.beforeCommitSpecifier ?? "<unspecified>",
            input.afterCommitSpecifier
          )
        }
        const path = input.afterPath ?? input.beforePath
        return {
          differences: revision.files
            .filter((file) => path === undefined || file.path === path)
            .map((file) => ({
              ...(!(file.before === undefined) && {
                beforeBlob: { blobId: file.before.blobId, path: file.path, mode: "100644" }
              }),
              ...(!(file.after === undefined) && {
                afterBlob: { blobId: file.after.blobId, path: file.path, mode: "100644" }
              }),
              changeType: file.before === undefined ? "A" : file.after === undefined ? "D" : "M"
            }))
        }
      }
      case "GetBlob": {
        const input = yield* decode(GetBlobInput, rawInput)
        const blob = state.scenario.repositories
          .find((repository) => repository.repositoryName === input.repositoryName)
          ?.pullRequests.flatMap((pullRequest) => pullRequest.revisions)
          .flatMap((revision) => revision.files)
          .flatMap((file) => [file.before, file.after])
          .find((candidate) => candidate?.blobId === input.blobId)
        if (blob === undefined) {
          return yield* new MockOperationError({
            awsTag: "BlobIdDoesNotExistException",
            message: `blob ${input.blobId} does not exist`,
            status: 400
          })
        }
        return { content: Buffer.from(blob.content, "utf8").toString("base64") }
      }
      case "GetCommentsForPullRequest": {
        const input = yield* decode(ReviewTargetInput, rawInput)
        const found = findPullRequest(state, input.pullRequestId)
        if (found === null) return yield* missingPullRequest(input.pullRequestId)
        if (input.repositoryName !== undefined && found.repositoryName !== input.repositoryName) {
          return yield* missingRepository(input.repositoryName)
        }
        const comments = state.comments.filter((comment) =>
          comment.pullRequestId === input.pullRequestId &&
          (input.repositoryName === undefined || comment.repositoryName === input.repositoryName) &&
          (input.beforeCommitId === undefined || comment.beforeCommitId === input.beforeCommitId) &&
          (input.afterCommitId === undefined || comment.afterCommitId === input.afterCommitId)
        )
        return {
          commentsForPullRequestData: comments
            .filter((comment) => comment.inReplyTo === null)
            .map((comment) => makeCommentGroup(comment, comments))
        }
      }
      case "PostCommentForPullRequest": {
        const input = yield* decode(PostCommentInput, rawInput)
        const location = optionalLocation(input.location)
        const found = findPullRequest(state, input.pullRequestId)
        if (found === null) return yield* missingPullRequest(input.pullRequestId)
        if (found.repositoryName !== input.repositoryName) {
          return yield* missingRepository(input.repositoryName)
        }
        const revisionExists = found.pullRequest.revisions.some((revision) =>
          revision.destinationCommit === input.beforeCommitId && revision.sourceCommit === input.afterCommitId
        )
        if (!revisionExists) return yield* commitTupleMismatch(input.beforeCommitId, input.afterCommitId)
        const outcome = yield* Ref.modify(
          stateRef,
          (current): readonly [RootCommentWriteOutcome, CodeCommitMockState] => {
            const existing = input.clientRequestToken === undefined
              ? undefined
              : current.comments.find((comment) => comment.clientRequestToken === input.clientRequestToken)
            if (existing !== undefined) {
              const exactReplay = existing.inReplyTo === null &&
                existing.pullRequestId === input.pullRequestId &&
                existing.repositoryName === input.repositoryName &&
                existing.beforeCommitId === input.beforeCommitId &&
                existing.afterCommitId === input.afterCommitId &&
                existing.content === input.content &&
                locationsEqual(existing.location, location)
              return exactReplay
                ? [{ _tag: "replayed", comment: existing }, current]
                : [{ _tag: "mismatch", clientRequestToken: input.clientRequestToken ?? "" }, current]
            }
            const comment: MockComment = {
              commentId: `comment-${current.comments.length + 1}`,
              pullRequestId: input.pullRequestId,
              repositoryName: input.repositoryName,
              beforeCommitId: input.beforeCommitId,
              afterCommitId: input.afterCommitId,
              content: input.content,
              authorArn: current.scenario.callerArn,
              creationEpochSeconds: Math.max(
                ...current.scenario.repositories.flatMap((repository) =>
                  repository.pullRequests.flatMap((pullRequest) =>
                    pullRequest.revisions.map((revision) => revision.activityEpochSeconds)
                  )
                )
              ) + current.comments.length + 1,
              clientRequestToken: input.clientRequestToken ?? null,
              inReplyTo: null,
              location
            }
            return [
              { _tag: "inserted", comment },
              { ...current, comments: [...current.comments, comment] }
            ]
          }
        )
        if (outcome._tag === "mismatch") return yield* idempotencyMismatch(outcome.clientRequestToken)
        const comment = outcome.comment
        return {
          repositoryName: comment.repositoryName,
          pullRequestId: comment.pullRequestId,
          beforeCommitId: comment.beforeCommitId,
          afterCommitId: comment.afterCommitId,
          ...(!(comment.location === null) && { location: comment.location }),
          comment: commentOutput(comment)
        }
      }
      case "UpdateComment": {
        const input = yield* decode(UpdateCommentInput, rawInput)
        const existing = state.comments.find((comment) => comment.commentId === input.commentId)
        if (existing === undefined) {
          return yield* new MockOperationError({
            awsTag: "CommentDoesNotExistException",
            message: `comment ${input.commentId} does not exist`,
            status: 400
          })
        }
        const updated = { ...existing, content: input.content }
        yield* Ref.update(stateRef, (current) => ({
          ...current,
          comments: current.comments.map((comment) => comment.commentId === input.commentId ? updated : comment)
        }))
        return { comment: commentOutput(updated) }
      }
      case "PostCommentReply": {
        const input = yield* decode(PostReplyInput, rawInput)
        const outcome = yield* Ref.modify(stateRef, (current): readonly [CommentWriteOutcome, CodeCommitMockState] => {
          const parent = current.comments.find((comment) => comment.commentId === input.inReplyTo)
          if (parent === undefined) {
            return [{ _tag: "missing-parent", commentId: input.inReplyTo }, current]
          }
          const existing = input.clientRequestToken === undefined
            ? undefined
            : current.comments.find((comment) => comment.clientRequestToken === input.clientRequestToken)
          if (existing !== undefined) {
            const exactReplay = existing.inReplyTo === input.inReplyTo && existing.content === input.content
            return exactReplay
              ? [{ _tag: "replayed", comment: existing }, current]
              : [{ _tag: "mismatch", clientRequestToken: input.clientRequestToken ?? "" }, current]
          }
          const reply: MockComment = {
            ...parent,
            commentId: `comment-${current.comments.length + 1}`,
            content: input.content,
            authorArn: current.scenario.callerArn,
            creationEpochSeconds: parent.creationEpochSeconds + current.comments.length + 1,
            clientRequestToken: input.clientRequestToken ?? null,
            inReplyTo: input.inReplyTo
          }
          return [
            { _tag: "inserted", comment: reply },
            { ...current, comments: [...current.comments, reply] }
          ]
        })
        if (outcome._tag === "missing-parent") {
          return yield* new MockOperationError({
            awsTag: "CommentDoesNotExistException",
            message: `comment ${outcome.commentId} does not exist`,
            status: 400
          })
        }
        if (outcome._tag === "mismatch") return yield* idempotencyMismatch(outcome.clientRequestToken)
        return { comment: commentOutput(outcome.comment) }
      }
      case "UpdatePullRequestApprovalState": {
        const input = yield* decode(ApprovalInput, rawInput)
        const found = findPullRequest(state, input.pullRequestId)
        if (found === null) return yield* missingPullRequest(input.pullRequestId)
        if (activeRevision(state, found.pullRequest).revisionId !== input.revisionId) {
          return yield* new MockOperationError({
            awsTag: "RevisionNotCurrentException",
            message: `revision ${input.revisionId} is not current`,
            status: 400
          })
        }
        yield* Ref.update(stateRef, (current) => ({
          ...current,
          approvals: [
            ...current.approvals.filter((approval) =>
              approval.pullRequestId !== input.pullRequestId || approval.revisionId !== input.revisionId
            ),
            { pullRequestId: input.pullRequestId, revisionId: input.revisionId, state: input.approvalState }
          ]
        }))
        return {}
      }
      case "GetPullRequestApprovalStates": {
        const input = yield* decode(RevisionInput, rawInput)
        return {
          approvals: state.approvals
            .filter((approval) =>
              approval.pullRequestId === input.pullRequestId && approval.revisionId === input.revisionId
            )
            .map((approval) => ({ userArn: state.scenario.callerArn, approvalState: approval.state }))
        }
      }
      case "EvaluatePullRequestApprovalRules": {
        const input = yield* decode(RevisionInput, rawInput)
        const approved = state.approvals.some((approval) =>
          approval.pullRequestId === input.pullRequestId &&
          approval.revisionId === input.revisionId &&
          approval.state === "APPROVE"
        )
        return {
          evaluation: {
            approved,
            overridden: false,
            approvalRulesSatisfied: approved ? ["mock-review"] : [],
            approvalRulesNotSatisfied: approved ? [] : ["mock-review"]
          }
        }
      }
      case "GetMergeConflicts": {
        const input = yield* decode(MergeConflictsInput, rawInput)
        return {
          mergeable: true,
          destinationCommitId: input.destinationCommitSpecifier,
          sourceCommitId: input.sourceCommitSpecifier,
          conflictMetadataList: []
        }
      }
      default:
        return yield* new MockOperationError({
          awsTag: "UnknownOperationException",
          message: `operation ${operation} is not implemented by the mock`,
          status: 400
        })
    }
  })

const awsJsonResponse = (body: Schema.Json) =>
  HttpServerResponse.jsonUnsafe(body, {
    headers: { "content-type": "application/x-amz-json-1.1" }
  })

const awsErrorResponse = (error: MockOperationError) =>
  HttpServerResponse.jsonUnsafe(
    { __type: error.awsTag, message: error.message },
    { status: error.status, headers: { "x-amzn-errortype": error.awsTag } }
  )

const awsHandler = (stateRef: Ref.Ref<CodeCommitMockState>) =>
  Effect.gen(function*() {
    const request = yield* HttpServerRequest.HttpServerRequest
    const target = request.headers["x-amz-target"]
    if (target === undefined) {
      const body = yield* request.text
      if (body.includes("Action=GetCallerIdentity")) {
        const state = yield* Ref.get(stateRef)
        yield* recordRequest(stateRef, "GetCallerIdentity", {})
        return HttpServerResponse.text(
          `<?xml version="1.0" encoding="UTF-8"?><GetCallerIdentityResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><GetCallerIdentityResult><Arn>${state.scenario.callerArn}</Arn><UserId>mock-user</UserId><Account>${state.scenario.accountId}</Account></GetCallerIdentityResult><ResponseMetadata><RequestId>mock-request</RequestId></ResponseMetadata></GetCallerIdentityResponse>`,
          { headers: { "content-type": "text/xml" } }
        )
      }
      return awsErrorResponse(
        new MockOperationError({
          awsTag: "UnknownOperationException",
          message: "missing x-amz-target",
          status: 400
        })
      )
    }
    const operation = target.split(".").at(-1) ?? target
    const input = yield* HttpServerRequest.schemaBodyJson(Schema.Json).pipe(
      Effect.mapError(() =>
        new MockOperationError({
          awsTag: "InvalidRequestException",
          message: "request body must be JSON",
          status: 400
        })
      )
    )
    return yield* handleOperation(stateRef, operation, input).pipe(
      Effect.map(awsJsonResponse),
      Effect.catchTag("MockOperationError", (error) => Effect.succeed(awsErrorResponse(error)))
    )
  }).pipe(
    Effect.catchTag("MockOperationError", (error) => Effect.succeed(awsErrorResponse(error))),
    Effect.catch(() =>
      Effect.succeed(HttpServerResponse.jsonUnsafe(
        { error: "mock-handler-failed" },
        { status: 500 }
      ))
    )
  )

const adminPushHandler = (stateRef: Ref.Ref<CodeCommitMockState>) =>
  Effect.gen(function*() {
    const input = yield* HttpServerRequest.schemaBodyJson(AdminPushInput)
    const state = yield* Ref.get(stateRef)
    const found = findPullRequest(state, input.pullRequestId)
    if (found === null) return HttpServerResponse.jsonUnsafe({ error: "pull-request-not-found" }, { status: 404 })
    const currentIndex = state.activeRevisionByPullRequest[input.pullRequestId] ?? 0
    const nextIndex = currentIndex + 1
    if (found.pullRequest.revisions[nextIndex] === undefined) {
      return HttpServerResponse.jsonUnsafe({ error: "no-newer-revision" }, { status: 409 })
    }
    yield* Ref.update(stateRef, (current) => ({
      ...current,
      activeRevisionByPullRequest: {
        ...current.activeRevisionByPullRequest,
        [input.pullRequestId]: nextIndex
      }
    }))
    const nextState = yield* Ref.get(stateRef)
    return HttpServerResponse.jsonUnsafe({
      pullRequestId: input.pullRequestId,
      revisionId: activeRevision(nextState, found.pullRequest).revisionId
    })
  }).pipe(Effect.catch(() =>
    Effect.succeed(
      HttpServerResponse.jsonUnsafe({ error: "invalid-push-request" }, { status: 400 })
    )
  ))

const adminCommentHandler = (stateRef: Ref.Ref<CodeCommitMockState>) =>
  Effect.gen(function*() {
    const input = yield* HttpServerRequest.schemaBodyJson(AdminCommentInput)
    const comment = yield* Ref.modify(stateRef, (current): readonly [MockComment | null, CodeCommitMockState] => {
      const found = findPullRequest(current, input.pullRequestId)
      if (found === null) return [null, current]
      const revision = activeRevision(current, found.pullRequest)
      const inserted: MockComment = {
        commentId: `comment-${current.comments.length + 1}`,
        pullRequestId: input.pullRequestId,
        repositoryName: found.repositoryName,
        beforeCommitId: revision.destinationCommit,
        afterCommitId: revision.sourceCommit,
        content: input.content,
        authorArn: input.authorArn ?? found.pullRequest.authorArn,
        creationEpochSeconds: revision.activityEpochSeconds + current.comments.length + 1,
        clientRequestToken: null,
        inReplyTo: null,
        location: null
      }
      return [inserted, { ...current, comments: [...current.comments, inserted] }]
    })
    if (comment === null) {
      return HttpServerResponse.jsonUnsafe({ error: "pull-request-not-found" }, { status: 404 })
    }
    return HttpServerResponse.jsonUnsafe({ commentId: comment.commentId })
  }).pipe(Effect.catch(() =>
    Effect.succeed(
      HttpServerResponse.jsonUnsafe({ error: "invalid-comment-request" }, { status: 400 })
    )
  ))

export interface CodeCommitMockServer {
  readonly origin: string
  readonly consolePullRequestUrl: (repositoryName: string, pullRequestId: string) => string
  readonly state: Effect.Effect<CodeCommitMockState>
}

/** Start one deterministic, scoped mock on literal loopback. */
export const startCodeCommitMock = (
  scenario: CodeCommitMockScenario,
  port = 0
): Effect.Effect<CodeCommitMockServer, CodeCommitMockStartupError, Scope.Scope> =>
  Effect.gen(function*() {
    const stateRef = yield* Ref.make(makeInitialState(scenario))
    const scope = yield* Effect.scope
    const context = yield* Layer.build(
      NodeHttpServer.layerServer(createServer, { host: "127.0.0.1", port })
    ).pipe(
      Scope.provide(scope),
      Effect.mapError((cause) => new CodeCommitMockStartupError({ cause }))
    )
    const server = Context.get(context, HttpServer.HttpServer)
    if (server.address._tag !== "TcpAddress") {
      return yield* new CodeCommitMockStartupError({ cause: "mock did not bind TCP" })
    }
    const origin = `http://127.0.0.1:${server.address.port}`
    const router = yield* HttpRouter.make
    yield* router.add("POST", "/", awsHandler(stateRef))
    yield* router.add("GET", "/__mock/state", Ref.get(stateRef).pipe(Effect.map(HttpServerResponse.jsonUnsafe)))
    yield* router.add("POST", "/__mock/push", adminPushHandler(stateRef))
    yield* router.add("POST", "/__mock/comment", adminCommentHandler(stateRef))
    yield* router.add(
      "POST",
      "/__mock/reset",
      Ref.set(stateRef, makeInitialState(scenario)).pipe(
        Effect.as(HttpServerResponse.jsonUnsafe({ reset: true }))
      )
    )
    const app = router.asHttpEffect()
    yield* HttpServer.serveEffect(app).pipe(
      Effect.provideService(HttpServer.HttpServer, server),
      Effect.forkScoped
    )
    return {
      origin,
      consolePullRequestUrl: (repositoryName, pullRequestId) =>
        codecommitConsoleUrl(scenario.region, repositoryName, pullRequestId),
      state: Ref.get(stateRef)
    }
  })
