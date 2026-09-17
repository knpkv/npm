import * as codecommit from "@distilled.cloud/aws/codecommit"
import * as Credentials from "@distilled.cloud/aws/Credentials"
import * as Region from "@distilled.cloud/aws/Region"
import * as sts from "@distilled.cloud/aws/sts"
import { NodeHttpClient } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { AwsProfileName, AwsRegion, CodeCommitPullRequestUrl } from "@knpkv/codecommit-core/Domain.js"
import {
  codeCommitMockAwsClientConfig,
  decodeCodeCommitMockEndpoint,
  withCodeCommitMock
} from "@knpkv/codecommit-core/MockTransport.js"
import { CodeCommitReadClient } from "@knpkv/codecommit-core/ReadClient.js"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"

import { defaultScenario } from "../src/Scenario.js"
import { startCodeCommitMock } from "../src/Server.js"

const awsRuntime = (origin: string) => {
  const routedHttp = Layer.effect(
    HttpClient.HttpClient,
    HttpClient.HttpClient.pipe(Effect.map((client) => withCodeCommitMock(client, decodeCodeCommitMockEndpoint(origin))))
  ).pipe(Layer.provide(NodeHttpClient.layerFetch))

  return Layer.mergeAll(
    routedHttp,
    Credentials.fromCredentials(
      {
        accessKeyId: "mock-access-key",
        secretAccessKey: "mock-secret-key"
      },
      "eu-west-1"
    ),
    Layer.succeed(Region.Region, Effect.succeed("eu-west-1"))
  )
}

describe("CodeCommit mock server", () => {
  it.effect("emits decodable console links for commercial and China partitions", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const commercial = yield* startCodeCommitMock(defaultScenario)
        const china = yield* startCodeCommitMock({ ...defaultScenario, region: "cn-north-1" })
        const commercialUrl = commercial.consolePullRequestUrl("payments-api", "17")
        const chinaUrl = china.consolePullRequestUrl("payments-api", "17")
        const decodedCommercial = yield* Schema.decodeUnknownEffect(CodeCommitPullRequestUrl)(commercialUrl)
        const decodedChina = yield* Schema.decodeUnknownEffect(CodeCommitPullRequestUrl)(chinaUrl)

        expect(decodedCommercial.region).toBe("eu-west-1")
        expect(decodedChina.region).toBe("cn-north-1")
        expect(new URL(chinaUrl).hostname).toBe("cn-north-1.console.amazonaws.cn")
      })
    ))

  it.effect("uses fixture credentials without resolving the configured profile", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const mock = yield* startCodeCommitMock(defaultScenario)
        const routedHttp = Layer.effect(
          HttpClient.HttpClient,
          HttpClient.HttpClient.pipe(
            Effect.map((client) => withCodeCommitMock(client, decodeCodeCommitMockEndpoint(mock.origin)))
          )
        ).pipe(Layer.provide(NodeHttpClient.layerFetch))
        const runtimeContext = yield* Layer.build(
          CodeCommitReadClient.live.pipe(Layer.provide(codeCommitMockAwsClientConfig), Layer.provide(routedHttp))
        )
        const identity = yield* Effect.gen(function*() {
          const client = yield* CodeCommitReadClient
          return yield* client.discoverAccount({
            profile: Schema.decodeSync(AwsProfileName)("profile-that-must-not-exist"),
            region: Schema.decodeSync(AwsRegion)("eu-west-1")
          })
        }).pipe(Effect.provide(runtimeContext))
        expect(identity.accountId).toBe("123456789012")
      })
    ))

  it.effect("paginates pull requests, differences, and root comment groups", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const repository = defaultScenario.repositories[0]
        const firstPullRequest = repository.pullRequests[0]
        const mock = yield* startCodeCommitMock({
          ...defaultScenario,
          repositories: [{
            ...repository,
            pullRequests: [
              firstPullRequest,
              { ...firstPullRequest, pullRequestId: "18", title: "Second pull request" }
            ]
          }]
        })
        const runtime = yield* Layer.build(awsRuntime(mock.origin))

        const firstPullRequestPage = yield* codecommit.listPullRequests({
          repositoryName: "payments-api",
          maxResults: 1
        }).pipe(Effect.provide(runtime))
        expect(firstPullRequestPage.pullRequestIds).toEqual(["17"])
        expect(firstPullRequestPage.nextToken).toBe("1")
        const secondPullRequestPage = yield* codecommit.listPullRequests({
          repositoryName: "payments-api",
          maxResults: 1,
          nextToken: firstPullRequestPage.nextToken
        }).pipe(Effect.provide(runtime))
        expect(secondPullRequestPage.pullRequestIds).toEqual(["18"])
        expect(secondPullRequestPage.nextToken).toBeUndefined()

        const firstDifferencePage = yield* codecommit.getDifferences({
          repositoryName: "payments-api",
          beforeCommitSpecifier: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          afterCommitSpecifier: "2222222222222222222222222222222222222222",
          MaxResults: 1
        }).pipe(Effect.provide(runtime))
        expect(firstDifferencePage.differences).toHaveLength(1)
        expect(firstDifferencePage.NextToken).toBe("1")
        const secondDifferencePage = yield* codecommit.getDifferences({
          repositoryName: "payments-api",
          beforeCommitSpecifier: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          afterCommitSpecifier: "2222222222222222222222222222222222222222",
          MaxResults: 1,
          NextToken: firstDifferencePage.NextToken
        }).pipe(Effect.provide(runtime))
        expect(secondDifferencePage.differences).toHaveLength(1)
        expect(secondDifferencePage.NextToken).toBeUndefined()

        for (const content of ["First root", "Second root"]) {
          yield* codecommit.postCommentForPullRequest({
            pullRequestId: "17",
            repositoryName: "payments-api",
            beforeCommitId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            afterCommitId: "1111111111111111111111111111111111111111",
            content
          }).pipe(Effect.provide(runtime))
        }
        const firstCommentPage = yield* codecommit.getCommentsForPullRequest({
          pullRequestId: "17",
          maxResults: 1
        }).pipe(Effect.provide(runtime))
        expect(firstCommentPage.commentsForPullRequestData?.[0]?.comments?.[0]?.content).toBe("First root")
        expect(firstCommentPage.nextToken).toBe("1")
        const secondCommentPage = yield* codecommit.getCommentsForPullRequest({
          pullRequestId: "17",
          maxResults: 1,
          nextToken: firstCommentPage.nextToken
        }).pipe(Effect.provide(runtime))
        expect(secondCommentPage.commentsForPullRequestData?.[0]?.comments?.[0]?.content).toBe("Second root")
        expect(secondCommentPage.nextToken).toBeUndefined()
      })
    ))

  it.effect("runs the stale-head and publication cycle through the real AWS protocol", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const mock = yield* startCodeCommitMock(defaultScenario)
        const runtime = yield* Layer.build(awsRuntime(mock.origin))
        const rawHttpContext = yield* Layer.build(NodeHttpClient.layerFetch)

        const identity = yield* sts.getCallerIdentity({}).pipe(Effect.provide(runtime))
        expect(identity.Account).toBe("123456789012")

        const first = yield* codecommit.getPullRequest({ pullRequestId: "17" }).pipe(Effect.provide(runtime))
        expect(first.pullRequest.revisionId).toBe("revision-1")

        const posted = yield* codecommit
          .postCommentForPullRequest({
            pullRequestId: "17",
            repositoryName: "payments-api",
            beforeCommitId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            afterCommitId: "1111111111111111111111111111111111111111",
            content: "Persist the idempotency key before retrying.",
            clientRequestToken: "finding-1",
            location: { filePath: "src/retry.ts", filePosition: 1, relativeFileVersion: "AFTER" }
          })
          .pipe(Effect.provide(runtime))
        expect(posted.comment?.commentId).toBe("comment-1")
        const replayed = yield* codecommit
          .postCommentForPullRequest({
            pullRequestId: "17",
            repositoryName: "payments-api",
            beforeCommitId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            afterCommitId: "1111111111111111111111111111111111111111",
            content: "Persist the idempotency key before retrying.",
            clientRequestToken: "finding-1",
            location: { filePath: "src/retry.ts", filePosition: 1, relativeFileVersion: "AFTER" }
          })
          .pipe(Effect.provide(runtime))
        expect(replayed.comment?.commentId).toBe(posted.comment?.commentId)
        const relocatedReplay = yield* codecommit
          .postCommentForPullRequest({
            pullRequestId: "17",
            repositoryName: "payments-api",
            beforeCommitId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            afterCommitId: "1111111111111111111111111111111111111111",
            content: "Persist the idempotency key before retrying.",
            clientRequestToken: "finding-1",
            location: { filePath: "src/retry.ts", filePosition: 2, relativeFileVersion: "AFTER" }
          })
          .pipe(Effect.provide(runtime), Effect.flip)
        expect(relocatedReplay).toBeDefined()

        const invalidDifference = yield* codecommit
          .getDifferences({
            repositoryName: "payments-api",
            beforeCommitSpecifier: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            afterCommitSpecifier: "1111111111111111111111111111111111111111"
          })
          .pipe(Effect.provide(runtime), Effect.flip)
        expect(invalidDifference).toBeDefined()

        const invalidComment = yield* codecommit
          .postCommentForPullRequest({
            pullRequestId: "17",
            repositoryName: "payments-api",
            beforeCommitId: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            afterCommitId: "1111111111111111111111111111111111111111",
            content: "Impossible revision tuple."
          })
          .pipe(Effect.provide(runtime), Effect.flip)
        expect(invalidComment).toBeDefined()

        const firstReply = yield* codecommit
          .postCommentReply({
            inReplyTo: "comment-1",
            content: "Acknowledged.",
            clientRequestToken: "reply-1"
          })
          .pipe(Effect.provide(runtime))
        const retriedReply = yield* codecommit
          .postCommentReply({
            inReplyTo: "comment-1",
            content: "Acknowledged.",
            clientRequestToken: "reply-1"
          })
          .pipe(Effect.provide(runtime))
        const secondReply = yield* codecommit
          .postCommentReply({
            inReplyTo: "comment-1",
            content: "Fixed in the next push.",
            clientRequestToken: "reply-2"
          })
          .pipe(Effect.provide(runtime))
        expect(retriedReply.comment?.commentId).toBe(firstReply.comment?.commentId)
        expect(secondReply.comment?.commentId).not.toBe(firstReply.comment?.commentId)
        const conflictingReply = yield* codecommit
          .postCommentReply({
            inReplyTo: "comment-1",
            content: "Different content.",
            clientRequestToken: "reply-1"
          })
          .pipe(Effect.provide(runtime), Effect.flip)
        expect(conflictingReply).toBeDefined()
        yield* codecommit
          .updatePullRequestApprovalState({
            pullRequestId: "17",
            revisionId: "revision-1",
            approvalState: "APPROVE"
          })
          .pipe(Effect.provide(runtime))

        const client = Context.get(rawHttpContext, HttpClient.HttpClient)
        const pushed = yield* client.execute(
          HttpClientRequest.post(`${mock.origin}/__mock/push`).pipe(
            HttpClientRequest.bodyJsonUnsafe({ pullRequestId: "17" })
          )
        )
        expect(pushed.status).toBe(200)

        const second = yield* codecommit.getPullRequest({ pullRequestId: "17" }).pipe(Effect.provide(runtime))
        expect(second.pullRequest.revisionId).toBe("revision-2")
        expect(second.pullRequest.pullRequestTargets?.[0]?.sourceCommit).toBe(
          "2222222222222222222222222222222222222222"
        )
        const staleApproval = yield* codecommit
          .updatePullRequestApprovalState({
            pullRequestId: "17",
            revisionId: "revision-1",
            approvalState: "APPROVE"
          })
          .pipe(Effect.provide(runtime), Effect.flip)
        expect(staleApproval).toBeDefined()

        const comments = yield* codecommit
          .getCommentsForPullRequest({
            pullRequestId: "17",
            repositoryName: "payments-api",
            beforeCommitId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            afterCommitId: "1111111111111111111111111111111111111111"
          })
          .pipe(Effect.provide(runtime))
        expect(comments.commentsForPullRequestData?.[0]?.comments?.[0]?.content).toBe(
          "Persist the idempotency key before retrying."
        )
        expect(comments.commentsForPullRequestData).toHaveLength(1)
        expect(comments.commentsForPullRequestData?.[0]?.comments).toHaveLength(3)

        yield* client.execute(
          HttpClientRequest.post(`${mock.origin}/__mock/comment`).pipe(
            HttpClientRequest.bodyJsonUnsafe({
              pullRequestId: "17",
              content: "Addressed in revision 2."
            })
          )
        )
        const oldRevisionComments = yield* codecommit
          .getCommentsForPullRequest({
            pullRequestId: "17",
            repositoryName: "payments-api",
            beforeCommitId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            afterCommitId: "1111111111111111111111111111111111111111"
          })
          .pipe(Effect.provide(runtime))
        expect(
          oldRevisionComments.commentsForPullRequestData
            ?.flatMap((group) => group.comments ?? [])
            .some((comment) => comment.content === "Addressed in revision 2.")
        ).toBe(false)
        const newRevisionComments = yield* codecommit
          .getCommentsForPullRequest({
            pullRequestId: "17",
            repositoryName: "payments-api",
            beforeCommitId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            afterCommitId: "2222222222222222222222222222222222222222"
          })
          .pipe(Effect.provide(runtime))
        expect(newRevisionComments.commentsForPullRequestData).toHaveLength(1)
        const updatedComments = yield* codecommit
          .getCommentsForPullRequest({
            pullRequestId: "17"
          })
          .pipe(Effect.provide(runtime))
        expect(
          updatedComments.commentsForPullRequestData
            ?.flatMap((group) => group.comments ?? [])
            .some((comment) => comment.content === "Addressed in revision 2.")
        ).toBe(true)

        const state = yield* mock.state
        expect(state.comments).toHaveLength(4)
        expect(state.requests.map((request) => request.operation)).toEqual([
          "GetCallerIdentity",
          "GetPullRequest",
          "PostCommentForPullRequest",
          "PostCommentForPullRequest",
          "PostCommentForPullRequest",
          "GetDifferences",
          "PostCommentForPullRequest",
          "PostCommentReply",
          "PostCommentReply",
          "PostCommentReply",
          "PostCommentReply",
          "UpdatePullRequestApprovalState",
          "GetPullRequest",
          "UpdatePullRequestApprovalState",
          "GetCommentsForPullRequest",
          "GetCommentsForPullRequest",
          "GetCommentsForPullRequest",
          "GetCommentsForPullRequest"
        ])
      })
    ))

  it.effect("resets all mutable provider state", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const mock = yield* startCodeCommitMock(defaultScenario)
        const rawHttpContext = yield* Layer.build(NodeHttpClient.layerFetch)
        const client = Context.get(rawHttpContext, HttpClient.HttpClient)
        yield* client.execute(
          HttpClientRequest.post(`${mock.origin}/__mock/push`).pipe(
            HttpClientRequest.bodyJsonUnsafe({ pullRequestId: "17" })
          )
        )
        const reset = yield* client.execute(HttpClientRequest.post(`${mock.origin}/__mock/reset`))
        expect(reset.status).toBe(200)
        const state = yield* mock.state
        expect(state.activeRevisionByPullRequest["17"]).toBe(0)
        expect(state.comments).toEqual([])
        expect(state.requests).toEqual([])
      })
    ))

  it.effect("serializes concurrent idempotent comment writes", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const mock = yield* startCodeCommitMock(defaultScenario)
        const runtime = yield* Layer.build(awsRuntime(mock.origin))
        const post = (clientRequestToken: string) =>
          codecommit
            .postCommentForPullRequest({
              pullRequestId: "17",
              repositoryName: "payments-api",
              beforeCommitId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              afterCommitId: "1111111111111111111111111111111111111111",
              content: `Comment ${clientRequestToken}`,
              clientRequestToken
            })
            .pipe(Effect.provide(runtime))

        const replayed = yield* Effect.all([post("same"), post("same")], { concurrency: "unbounded" })
        expect(replayed[0].comment?.commentId).toBe(replayed[1].comment?.commentId)
        const distinct = yield* Effect.all([post("left"), post("right")], { concurrency: "unbounded" })
        expect(distinct[0].comment?.commentId).not.toBe(distinct[1].comment?.commentId)

        const state = yield* mock.state
        expect(state.comments).toHaveLength(3)
        expect(new Set(state.comments.map(({ commentId }) => commentId)).size).toBe(3)
      })
    ))
})
