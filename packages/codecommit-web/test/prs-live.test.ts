import { describe, expect, it } from "@effect/vitest"
import { ConfigService, Domain, Errors, PRService } from "@knpkv/codecommit-core"
import { Deferred, Effect, Schema } from "effect"

import {
  cachedPullRequest,
  completeSinglePullRequestRefresh,
  resolveRelayReviewProfile,
  selectedPullRequest
} from "../src/server/handlers/prs-live.js"

const pullRequest = new Domain.PullRequest({
  account: new Domain.Account({
    profile: Domain.AwsProfileName.make("production"),
    region: Domain.AwsRegion.make("eu-west-1"),
    repoAccountId: "111122223333"
  }),
  approvalRules: [],
  approvedBy: [],
  approvedByArns: [],
  author: "reviewer",
  commentedBy: [],
  creationDate: new Date(0),
  destinationBranch: "main",
  id: Domain.PullRequestId.make("42"),
  isApproved: false,
  isMergeable: true,
  lastModifiedDate: new Date(1_000),
  link: "https://example.invalid/pr/42",
  repositoryName: Domain.RepositoryName.make("payments"),
  sourceBranch: "feature",
  status: "OPEN",
  title: "Review"
})

const awsAccountPullRequest = new Domain.PullRequest({
  ...pullRequest,
  account: new Domain.Account({
    profile: Domain.AwsProfileName.make("staging"),
    region: Domain.AwsRegion.make("eu-west-1"),
    awsAccountId: "444455556666"
  })
})

describe("PR handler selection", () => {
  it.effect("accepts only the exact server-owned Relay profile snapshot", () =>
    Effect.gen(function*() {
      const configured = ConfigService.defaultReviewConfig.profiles[0]
      if (configured === undefined) return
      const service = {
        load: Effect.succeed({
          accounts: [],
          autoDetect: false,
          autoRefresh: false,
          refreshIntervalSeconds: 300,
          review: ConfigService.defaultReviewConfig,
          sandbox: ConfigService.defaultSandboxConfig
        })
      }

      expect(yield* resolveRelayReviewProfile(service, configured)).toEqual(configured)
      const failure = yield* resolveRelayReviewProfile(service, { ...configured, model: "gpt-5.6-luna" }).pipe(
        Effect.flip
      )
      expect(failure.message).toContain("unknown or has changed")
    }))

  it.effect("acknowledges a manual refresh only after its provider projection completes", () =>
    Effect.gen(function*() {
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const acknowledged = yield* Deferred.make<{ readonly revisionId: string; readonly headCommit: string }>()
      const refreshedRevision: PRService.RefreshSinglePRResult = {
        revisionId: "revision-2",
        sourceCommit: "c".repeat(40)
      }
      const refresh = Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
        Effect.as(refreshedRevision)
      )

      yield* completeSinglePullRequestRefresh(refresh).pipe(
        Effect.flatMap((response) => Deferred.succeed(acknowledged, response)),
        Effect.forkChild
      )
      yield* Deferred.await(started)
      expect(yield* Deferred.isDone(acknowledged)).toBe(false)

      yield* Deferred.succeed(release, undefined)
      expect(yield* Deferred.await(acknowledged)).toEqual({
        revisionId: refreshedRevision.revisionId,
        headCommit: refreshedRevision.sourceCommit
      })
    }))

  it.effect("does not acknowledge a provider-denied manual refresh", () =>
    Effect.gen(function*() {
      const denial = new Errors.AwsApiError({
        operation: "getPullRequest",
        profile: Domain.AwsProfileName.make("production"),
        region: Domain.AwsRegion.make("eu-west-1"),
        cause: { _tag: "AccessDeniedException" }
      })
      const failure = yield* completeSinglePullRequestRefresh(
        Effect.fail<PRService.RefreshSinglePRResult, Errors.AwsApiError>(denial)
      ).pipe(Effect.flip)

      expect(failure).toBe(denial)
    }))

  it.effect("matches the repository account identifier used by browser routes", () =>
    Effect.gen(function*() {
      const selected = yield* selectedPullRequest([pullRequest], "111122223333", pullRequest.id)
      expect(selected).toBe(pullRequest)

      const byAwsAccount = yield* selectedPullRequest(
        [awsAccountPullRequest],
        "444455556666",
        awsAccountPullRequest.id
      )
      expect(byAwsAccount).toBe(awsAccountPullRequest)

      const failure = yield* selectedPullRequest([pullRequest], "999900001111", pullRequest.id).pipe(Effect.flip)
      expect(failure.message).toContain("not available")
    }))

  it.effect("resolves a direct-linked pull request from the durable SSE cache", () =>
    Effect.gen(function*() {
      const cached = Schema.encodeSync(PRService.CachedPRToPullRequest)(pullRequest)
      const cache = {
        findAll: () => Effect.succeed([cached])
      }

      const selected = yield* cachedPullRequest(cache, "111122223333", pullRequest.id)
      expect(selected.id).toBe(pullRequest.id)
      const selectedByProfile = yield* cachedPullRequest(cache, "production", pullRequest.id)
      expect(selectedByProfile.id).toBe(pullRequest.id)

      const mismatch = yield* cachedPullRequest(cache, "unrelated", pullRequest.id).pipe(Effect.flip)
      expect(mismatch.message).toContain("not available")
    }))
})
