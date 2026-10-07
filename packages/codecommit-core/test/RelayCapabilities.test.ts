import { NodeServices } from "@effect/platform-node"
import { describe, expect, layer } from "@effect/vitest"
import { describeCall, invoke } from "@knpkv/capability"
import { Effect, Exit, Layer, Option, Schema } from "effect"
import { CachedPullRequest, PullRequestRepo } from "../src/CacheService/repos/PullRequestRepo/index.js"
import { ConfigService } from "../src/ConfigService/index.js"
import { TuiConfig } from "../src/ConfigService/internal.js"
import { AwsProfileName, AwsRegion } from "../src/Domain.js"
import { AwsCredentialError } from "../src/Errors.js"
import { CodeCommitPullRequestRevision, CodeCommitReadClient } from "../src/ReadClient/index.js"
import {
  capabilities,
  postComment,
  type PullRequestCommentAction,
  PullRequestCommentPoster
} from "../src/RelayCapabilities/index.js"
import { CodeCommitReviewReceipt } from "../src/ReviewClient/index.js"

const {
  getPullRequest: getPullRequestCapability,
  listPullRequests: listPullRequestsCapability,
  postComment: postCommentCapability
} = capabilities

const row = (profile: string, id: string, overrides: Partial<Record<string, string | number | null>> = {}) =>
  Schema.decodeSync(CachedPullRequest)({
    id,
    awsAccountId: "123456789012",
    repoAccountId: null,
    accountProfile: profile,
    accountRegion: "us-east-1",
    title: `PR ${id}`,
    description: null,
    author: "Ada",
    repositoryName: "payments",
    creationDate: "2026-08-01T00:00:00.000Z",
    lastModifiedDate: "2026-08-02T00:00:00.000Z",
    status: "OPEN",
    sourceBranch: "feature",
    destinationBranch: "main",
    isMergeable: 1,
    isApproved: 0,
    approvalUnknownReason: null,
    observationSeq: 0,
    approvalVersion: "2026-08-02T00:00:00.000Z",
    approvalObservationSeq: 0,
    commentCount: 3,
    healthScore: null,
    link: `https://example.invalid/pr/${id}`,
    fetchedAt: "2026-08-02T00:00:00.000Z",
    filesAdded: 1,
    filesModified: 2,
    filesDeleted: 0,
    closedAt: null,
    mergedBy: null,
    approvedBy: null,
    approvedByArns: null,
    commentedBy: null,
    approvalRules: null,
    ...overrides
  })

const rows = [
  row("work", "42"),
  row("work", "41", { status: "MERGED", author: "Grace" }),
  row("switched-off", "40"),
  row("work", "39", { isApproved: 1, approvalUnknownReason: "NotPermitted" })
]

const config = Schema.decodeSync(TuiConfig)({
  accounts: [
    { profile: "work", regions: ["us-east-1"], enabled: true },
    { profile: "switched-off", regions: ["us-east-1"], enabled: false }
  ]
})

const pr42 = { accountId: "123456789012", region: "us-east-1", repositoryName: "payments", pullRequestId: "42" }

const revision = Schema.decodeUnknownSync(CodeCommitPullRequestRevision)({
  pullRequestId: "42",
  revisionId: "rev-7",
  repositoryName: "payments",
  title: "PR 42",
  authorArn: null,
  status: "OPEN",
  sourceReference: "refs/heads/feature",
  destinationReference: "refs/heads/main",
  sourceCommit: "a".repeat(40),
  destinationCommit: "b".repeat(40),
  mergeBase: null,
  creationDate: new Date("2026-08-01T00:00:00.000Z"),
  lastActivityDate: new Date("2026-08-02T00:00:00.000Z")
})

const posted: Array<PullRequestCommentAction> = []

const services = (options: {
  readonly load?: ConfigService["Service"]["load"]
  readonly getPullRequest?: CodeCommitReadClient["Service"]["getPullRequest"]
} = {}) =>
  Layer.mergeAll(
    Layer.mock(PullRequestRepo, {
      findAll: () => Effect.succeed(rows),
      findByCoordinates: (accountId, id, repositoryName, region) =>
        Effect.succeed(Option.fromNullishOr(rows.find((candidate) =>
          candidate.awsAccountId === accountId && candidate.id === id &&
          candidate.repositoryName === repositoryName && candidate.accountRegion === region
        )))
    }),
    Layer.mock(ConfigService, { load: options.load ?? Effect.succeed(config) }),
    Layer.mock(CodeCommitReadClient, {
      getPullRequest: options.getPullRequest ?? (() =>
        Effect.succeed(revision))
    }),
    Layer.mock(PullRequestCommentPoster, {
      post: (action) =>
        Effect.sync(() => {
          posted.push(action)
          return new CodeCommitReviewReceipt({ operationId: "comment:c-1", summary: "Pull request comment posted" })
        })
    }),
    NodeServices.layer
  )

layer(services())("CodeCommit Relay capabilities", (it) => {
  it.effect("reads one pull request from the cache and cites it", () =>
    Effect.gen(function*() {
      const result = yield* invoke(getPullRequestCapability, { pullRequest: pr42 })
      expect(result.output).toMatchObject({
        title: "PR 42",
        author: "Ada",
        mergeable: true,
        approval: { _tag: "Pending" },
        filesChanged: { added: 1, modified: 2, deleted: 0 }
      })
      expect(result.cites).toEqual([
        { product: "codecommit", kind: "pull-request", id: "123456789012/us-east-1/payments/42" }
      ])
    }))

  it.effect("reads approval as unknown over a stale approved flag, with the queue's explanation", () =>
    Effect.gen(function*() {
      const result = yield* invoke(getPullRequestCapability, { pullRequest: { ...pr42, pullRequestId: "39" } })
      expect(result.output).toMatchObject({
        approval: {
          _tag: "Unknown",
          reason: "NotPermitted",
          explanation: "Not allowed to check approval rules (codecommit:EvaluatePullRequestApprovalRules)."
        }
      })
    }))

  it.effect("names the refresh when a pull request isn't cached", () =>
    Effect.gen(function*() {
      const exit = yield* Effect.exit(
        invoke(getPullRequestCapability, { pullRequest: { ...pr42, pullRequestId: "9" } })
      )
      expect(exit).toMatchObject(Exit.fail({ _tag: "CapabilityFailed", tag: "PullRequestNotCached" }))
      expect(JSON.stringify(exit)).toContain("Refresh the pull-request queue")
    }))

  it.effect("lists like the queue: switched-off accounts hidden, filters applied, total before the limit", () =>
    Effect.gen(function*() {
      const all = yield* invoke(listPullRequestsCapability, { limit: 1 })
      expect(all.output).toMatchObject({ total: 3, pullRequests: [{ pullRequest: { pullRequestId: "42" } }] })
      const merged = yield* invoke(listPullRequestsCapability, { status: "MERGED", author: "grace", limit: 10 })
      expect(merged.output).toMatchObject({ total: 1, pullRequests: [{ pullRequest: { pullRequestId: "41" } }] })
      expect(merged.cites).toHaveLength(1)
    }))

  it.effect("posts a comment pinned to the provider's current revision, once per text and revision", () =>
    Effect.gen(function*() {
      posted.length = 0
      const first = yield* invoke(postCommentCapability, { pullRequest: pr42, content: "Looks good" })
      yield* invoke(postCommentCapability, { pullRequest: pr42, content: "Looks good" })
      yield* invoke(postCommentCapability, { pullRequest: pr42, content: "One more thing" })
      expect(first.output).toMatchObject({ operationId: "comment:c-1" })
      expect(posted[0]).toMatchObject({
        _tag: "comment",
        content: "Looks good",
        target: { account: { profile: "work", region: "us-east-1" }, revisionId: "rev-7", sourceCommit: "a".repeat(40) }
      })
      const tokens = posted.map((action) => action.clientRequestToken)
      expect(tokens[0]).toBe(tokens[1])
      expect(tokens[2]).not.toBe(tokens[0])
    }))

  it.effect("shows the person the exact comment and that it can't be undone", () =>
    Effect.gen(function*() {
      const action = yield* describeCall(postComment, { pullRequest: pr42, content: "Ship it" })
      expect(action).toEqual({
        verb: "post comment",
        target: { product: "codecommit", kind: "pull-request", id: "123456789012/us-east-1/payments/42" },
        args: { content: "Ship it" }
      })
      expect(postComment.reversible).toBe(false)
    }))
})

describe("when CodeCommit or the config can't answer", () => {
  layer(services({ load: Effect.fail("config.json is mid-write") }))((it) => {
    it.effect("fails the listing rather than showing switched-off accounts", () =>
      Effect.gen(function*() {
        const exit = yield* Effect.exit(invoke(listPullRequestsCapability, { limit: 10 }))
        expect(exit).toMatchObject(Exit.fail({ _tag: "CapabilityFailed", tag: "CodeCommitUnavailable" }))
      }))
  })

  layer(services({
    getPullRequest: () =>
      Effect.fail(
        new AwsCredentialError({
          profile: AwsProfileName.make("work"),
          region: AwsRegion.make("us-east-1"),
          cause: "token expired"
        })
      )
  }))((it) => {
    it.effect("tells the person how to sign in again when a post is refused", () =>
      Effect.gen(function*() {
        posted.length = 0
        const exit = yield* Effect.exit(invoke(postCommentCapability, { pullRequest: pr42, content: "Hi" }))
        expect(JSON.stringify(exit)).toContain("aws sso login --profile work")
        expect(posted).toEqual([])
      }))
  })
})
