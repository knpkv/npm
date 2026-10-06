import * as DistilledRetry from "@distilled.cloud/aws/Retry"
import { describe, expect, it } from "@effect/vitest"
import { Cause, Effect, Exit, Layer, Option, Predicate, Ref, Schema, Stream } from "effect"
import type { HttpClientRequest } from "effect/http"
import { HttpClient, HttpClientResponse } from "effect/http"
import { getPullRequest } from "../src/AwsClient/getPullRequest.js"
import { getPullRequestRefresh, getPullRequests } from "../src/AwsClient/getPullRequests.js"
import { layer as awsClientConfigLayer } from "../src/AwsClientConfig.js"
import { AwsProfileName, AwsRegion } from "../src/Domain.js"
import { codeCommitMockAwsClientConfig } from "../src/MockTransport.js"

const account = {
  profile: Schema.decodeSync(AwsProfileName)("dev"),
  region: Schema.decodeSync(AwsRegion)("eu-west-1")
}

const revisionId = "rev-1"
const pullRequest = {
  pullRequestId: "7",
  title: "Approved elsewhere",
  authorArn: "arn:aws:iam::111111111111:user/alice",
  pullRequestStatus: "OPEN",
  revisionId,
  creationDate: 1_700_000_000,
  lastActivityDate: 1_700_000_000,
  pullRequestTargets: [{
    repositoryName: "repo",
    sourceReference: "refs/heads/feature",
    destinationReference: "refs/heads/main",
    sourceCommit: "a".repeat(40),
    destinationCommit: "b".repeat(40),
    mergeMetadata: { isMerged: false }
  }],
  approvalRules: [{ approvalRuleName: "two-reviewers", approvalRuleContent: "{}" }]
}

/**
 * `"8-denied"`: three open pull requests, and evaluation is denied for pull request 8 only.
 * `"three-approved"`: three open pull requests in one repository, all approved.
 * `"throttled"`: one pull request whose evaluation is always throttled.
 */
type Evaluation = "approved" | "denied" | "8-denied" | "three-approved" | "throttled"

const threePullRequests = (evaluation: Evaluation) => evaluation === "8-denied" || evaluation === "three-approved"

const RequestedPullRequest = Schema.fromJsonString(Schema.Struct({ pullRequestId: Schema.String }))
const requestedPullRequestId = (body: HttpClientRequest.HttpClientRequest["body"]) =>
  body._tag === "Uint8Array"
    ? Schema.decodeUnknownSync(RequestedPullRequest)(new TextDecoder().decode(body.body)).pullRequestId
    : "7"

/**
 * One CodeCommit account answered at the AWS JSON protocol. When `calls` is given, every operation
 * the client sends is recorded in order.
 */
const codeCommit = (evaluation: Evaluation, calls?: Ref.Ref<ReadonlyArray<string>>) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      const operation = (request.headers["x-amz-target"] ?? "").split(".").at(-1)
      const recorded = calls === undefined ? Effect.void : Ref.update(calls, (all) => [...all, operation ?? ""])
      return recorded.pipe(Effect.andThen(answer(evaluation, request, operation)))
    })
  ).pipe(Layer.merge(evaluation === "throttled" ? fastRetries : codeCommitMockAwsClientConfig))

/** One provider retry with no delay, so a throttled call's retry count is observable and quick. */
const fastRetries = awsClientConfigLayer({
  credentialProvider: () =>
    Promise.resolve({
      accessKeyId: "CODECOMMITMOCKACCESSKEY",
      secretAccessKey: "codecommit-mock-secret-not-valid-for-aws"
    }),
  maxRetries: 1,
  retryBaseDelay: "0 millis",
  maxRetryDelay: "0 millis"
})

const answer = (
  evaluation: Evaluation,
  request: HttpClientRequest.HttpClientRequest,
  operation: string | undefined
) => {
  const respond = (body: Schema.Json, init: ResponseInit) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, new Response(JSON.stringify(body), init)))
  const json = (body: Schema.Json) =>
    respond(body, { status: 200, headers: { "content-type": "application/x-amz-json-1.1" } })
  const awsError = (errorType: string, message = "not authorized") =>
    respond({ __type: errorType, message }, {
      status: 400,
      headers: { "content-type": "application/x-amz-json-1.1", "x-amzn-errortype": errorType }
    })
  switch (operation) {
    case "ListRepositories":
      return json({ repositories: [{ repositoryName: "repo" }] })
    case "ListPullRequests":
      return json({ pullRequestIds: threePullRequests(evaluation) ? ["7", "8", "9"] : ["7"] })
    case "GetPullRequest":
      return json({ pullRequest: { ...pullRequest, pullRequestId: requestedPullRequestId(request.body) } })
    case "GetRepository":
      return json({ repositoryMetadata: { accountId: "111111111111" } })
    case "GetPullRequestApprovalStates":
      return json({ approvals: [] })
    case "GetMergeConflicts":
      return json({ mergeable: true })
    case "EvaluatePullRequestApprovalRules":
      return evaluation === "throttled"
        ? awsError("ThrottlingException", "Rate exceeded")
        : evaluation === "approved" || evaluation === "three-approved" ||
            (evaluation === "8-denied" && requestedPullRequestId(request.body) !== "8")
        ? json({ evaluation: { approved: true, approvalRulesSatisfied: ["two-reviewers"] } })
        : awsError("AccessDeniedException")
    default:
      return awsError("UnknownOperationException")
  }
}

/** The provider failure an AwsApiError wraps, when the run failed with one. */
const wrappedFailure = <A, E extends { readonly cause: unknown }>(exit: Exit.Exit<A, E>) =>
  Exit.isFailure(exit) ? Option.map(Cause.findErrorOption(exit.cause), (error) => error.cause) : Option.none()

const isApprovalEvaluationError = (cause: Option.Option<unknown>) =>
  Option.exists(cause, Predicate.isTagged("ApprovalEvaluationError"))

describe("approval evaluation", () => {
  it.layer(codeCommit("approved"))((it) => {
    it.effect("maps an evaluation into approval and satisfied rules", () =>
      Effect.gen(function*() {
        const [pr] = yield* Stream.runCollect(getPullRequests(account))
        expect(pr?.isApproved).toBe(true)
        expect(pr?.approvalRules?.map((rule) => [rule.ruleName, rule.satisfied])).toEqual([["two-reviewers", true]])
      }))
  })

  it.layer(codeCommit("denied"))((it) => {
    it.effect("fails the refresh instead of listing the pull request as pending when evaluation fails", () =>
      Effect.gen(function*() {
        const exit = yield* Effect.exit(Stream.runCollect(getPullRequests(account)))
        expect(isApprovalEvaluationError(wrappedFailure(exit))).toBe(true)
      }))

    it.effect("fails the pull-request detail instead of reporting every rule unsatisfied", () =>
      Effect.gen(function*() {
        const exit = yield* Effect.exit(getPullRequest({ account, pullRequestId: "7" }))
        expect(isApprovalEvaluationError(wrappedFailure(exit))).toBe(true)
        // The web detail view shows the wrapped error's message, so it must say what failed.
        expect(Option.map(wrappedFailure(exit), (cause) => Predicate.hasProperty(cause, "message") && cause.message))
          .toEqual(Option.some(expect.stringContaining("EvaluatePullRequestApprovalRules")))
      }))
  })

  it.layer(codeCommit("8-denied"))((it) => {
    it.effect("keeps streaming the other pull requests when one fails evaluation", () =>
      Effect.gen(function*() {
        const items = yield* Stream.runCollect(getPullRequestRefresh(account))
        expect(
          [...items].map((item) =>
            item._tag === "Fetched" ? `fetched ${item.pullRequest.id}` : `unevaluated ${item.pullRequestId}`
          ).toSorted()
        ).toEqual(["fetched 7", "fetched 9", "unevaluated 8"])
      }))

    it.effect("still fails getPullRequests, which has no way to report one pull request as unknown", () =>
      Effect.gen(function*() {
        const exit = yield* Effect.exit(Stream.runCollect(getPullRequests(account)))
        expect(isApprovalEvaluationError(wrappedFailure(exit))).toBe(true)
      }))
  })

  it.effect("looks up a repository's account once, however many of its pull requests are read", () =>
    Effect.gen(function*() {
      const calls = yield* Ref.make<ReadonlyArray<string>>([])
      const items = yield* Stream.runCollect(getPullRequestRefresh(account)).pipe(
        // Test entry point: this test's own recording transport is provided once here.
        // @effect-diagnostics-next-line strictEffectProvide:off
        Effect.provide(codeCommit("three-approved", calls))
      )
      expect(items).toHaveLength(3)
      expect((yield* Ref.get(calls)).filter((operation) => operation === "GetRepository")).toHaveLength(1)
    }))

  it.effect("spends an evaluation's retries once, then reports it unevaluated", () =>
    Effect.gen(function*() {
      const calls = yield* Ref.make<ReadonlyArray<string>>([])
      // The SDK's own retries are off, so only our throttle-retry budget is counted.
      const items = yield* Stream.runCollect(getPullRequestRefresh(account)).pipe(
        DistilledRetry.none,
        // Test entry point: this test's own recording transport is provided once here.
        // @effect-diagnostics-next-line strictEffectProvide:off
        Effect.provide(codeCommit("throttled", calls))
      )
      expect([...items].map((item) => item._tag)).toEqual(["EvaluationFailed"])
      const made = yield* Ref.get(calls)
      // One read of the pull request, and the evaluation tried once plus its single retry.
      expect(made.filter((operation) => operation === "GetPullRequest")).toHaveLength(1)
      expect(made.filter((operation) => operation === "EvaluatePullRequestApprovalRules")).toHaveLength(2)
    }))
})
