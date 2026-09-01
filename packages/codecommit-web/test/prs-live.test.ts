import { describe, expect, it } from "@effect/vitest"
import { ConfigService, Domain, Errors, PRService } from "@knpkv/codecommit-core"
import { Deferred, Effect, Encoding, Schema } from "effect"
import {
  coordinateRouterMaxParamLength,
  decodePullRequestCoordinates,
  encodePullRequestCoordinates
} from "../src/pull-request-coordinates.js"

import { SubscriptionPayload } from "../src/server/Api.js"
import {
  cachedPullRequest,
  completeSinglePullRequestRefresh,
  refreshRouteCoordinates,
  resolveRelayReviewExecution,
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

const otherRepositoryPullRequest = new Domain.PullRequest({
  ...pullRequest,
  repositoryName: Domain.RepositoryName.make("identity")
})

describe("PR handler selection", () => {
  it("rejects partial subscription coordinates", () => {
    const decode = Schema.decodeUnknownResult(SubscriptionPayload)
    expect(decode({ awsAccountId: "123", pullRequestId: "42", repositoryName: "payments" })._tag).toBe("Failure")
    expect(decode({ awsAccountId: "123", pullRequestId: "42", region: "eu-west-1" })._tag).toBe("Failure")
    expect(decode({ awsAccountId: "123", pullRequestId: "42" })._tag).toBe("Success")
    expect(
      decode({ awsAccountId: "123", pullRequestId: "42", repositoryName: "", region: "" })._tag
    ).toBe("Failure")
    expect(
      decode({
        awsAccountId: "123",
        pullRequestId: "42",
        repositoryName: "payments",
        region: "eu-west-1"
      })._tag
    ).toBe("Success")
  })

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

  it.effect("resolves profile skills as one Relay execution configuration", () =>
    Effect.gen(function*() {
      const configured = ConfigService.defaultReviewConfig.profiles[0]
      const explain = ConfigService.defaultReviewConfig.profiles.find(({ kind }) => kind === "explain")
      if (configured === undefined || explain === undefined) return
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
      const skills = configured.skillIds.map((id) => ({
        id,
        name: id,
        description: "Configured review method.",
        source: "Test",
        prompt: `Apply ${id}`
      }))

      const execution = yield* resolveRelayReviewExecution(service, configured, skills)
      expect(execution.profile).toEqual(configured)
      expect(execution.skillPrompt).toContain(`Apply ${configured.skillIds[0] ?? "missing"}`)

      const unavailable = yield* resolveRelayReviewExecution(service, configured, skills.slice(0, 1)).pipe(
        Effect.flip
      )
      expect(unavailable.message).toContain("unavailable")

      expect((yield* resolveRelayReviewExecution(service, explain, skills)).skillPrompt).toBe("")
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
      const selected = yield* selectedPullRequest([pullRequest], "111122223333", pullRequest.id, {
        region: "eu-west-1",
        repositoryName: "payments"
      })
      expect(selected).toBe(pullRequest)

      const byAwsAccount = yield* selectedPullRequest(
        [awsAccountPullRequest],
        "444455556666",
        awsAccountPullRequest.id,
        { region: "eu-west-1", repositoryName: "payments" }
      )
      expect(byAwsAccount).toBe(awsAccountPullRequest)

      const failure = yield* selectedPullRequest([pullRequest], "999900001111", pullRequest.id, {
        region: "eu-west-1",
        repositoryName: "payments"
      }).pipe(Effect.flip)
      expect(failure.message).toContain("not available")

      const selectedRepository = yield* selectedPullRequest(
        [pullRequest, otherRepositoryPullRequest],
        "111122223333",
        pullRequest.id,
        { region: "eu-west-1", repositoryName: "identity" }
      )
      expect(selectedRepository).toBe(otherRepositoryPullRequest)
    }))

  it.effect("resolves a direct-linked pull request from the durable SSE cache", () =>
    Effect.gen(function*() {
      const cached = Schema.encodeSync(PRService.CachedPRToPullRequest)(pullRequest)
      const cachedOtherRepository = Schema.encodeSync(PRService.CachedPRToPullRequest)(otherRepositoryPullRequest)
      const cache = {
        findAll: () => Effect.succeed([cached, cachedOtherRepository])
      }

      const selected = yield* cachedPullRequest(cache, "111122223333", pullRequest.id, {
        region: "eu-west-1",
        repositoryName: "payments"
      })
      expect(selected.id).toBe(pullRequest.id)
      const selectedByProfile = yield* cachedPullRequest(cache, "production", pullRequest.id, {
        region: "eu-west-1",
        repositoryName: "payments"
      })
      expect(selectedByProfile.id).toBe(pullRequest.id)

      const mismatch = yield* cachedPullRequest(cache, "unrelated", pullRequest.id, {
        region: "eu-west-1",
        repositoryName: "payments"
      }).pipe(Effect.flip)
      expect(mismatch.message).toContain("not available")

      const regionalMismatch = yield* cachedPullRequest(cache, "111122223333", pullRequest.id, {
        region: "us-east-1",
        repositoryName: "payments"
      }).pipe(Effect.flip)
      expect(regionalMismatch.message).toContain("not available")

      const repositoryMatch = yield* cachedPullRequest(cache, "111122223333", pullRequest.id, {
        region: "eu-west-1",
        repositoryName: "identity"
      })
      expect(repositoryMatch.repositoryName).toBe("identity")
    }))

  it.effect("keeps profile routes that begin with the coordinate prefix addressable", () =>
    Effect.gen(function*() {
      const prefixedProfile = new Domain.PullRequest({
        ...pullRequest,
        account: new Domain.Account({
          profile: Domain.AwsProfileName.make("cc1_production"),
          region: pullRequest.account.region,
          awsAccountId: undefined,
          repoAccountId: undefined
        })
      })
      const cached = Schema.encodeSync(PRService.CachedPRToPullRequest)(prefixedProfile)
      const selected = yield* cachedPullRequest(
        { findAll: () => Effect.succeed([cached]) },
        "cc1_production",
        prefixedProfile.id,
        { repositoryName: "payments", region: "eu-west-1" }
      )
      expect(selected.account.profile).toBe("cc1_production")

      const legacyPrefixedProfile = new Domain.PullRequest({
        ...prefixedProfile,
        account: new Domain.Account({
          ...prefixedProfile.account,
          profile: Domain.AwsProfileName.make("ccpr:production")
        })
      })
      const legacySelected = yield* cachedPullRequest(
        { findAll: () => Effect.succeed([Schema.encodeSync(PRService.CachedPRToPullRequest)(legacyPrefixedProfile)]) },
        "ccpr:production",
        legacyPrefixedProfile.id,
        { repositoryName: "payments", region: "eu-west-1" }
      )
      expect(legacySelected.account.profile).toBe("ccpr:production")
    }))

  it.effect("requires exact coordinates when duplicate account and PR identifiers exist", () =>
    Effect.gen(function*() {
      const regionalPullRequest = new Domain.PullRequest({
        ...pullRequest,
        account: new Domain.Account({
          profile: pullRequest.account.profile,
          region: Domain.AwsRegion.make("us-east-1"),
          repoAccountId: pullRequest.account.repoAccountId
        }),
        repositoryName: Domain.RepositoryName.make("payments-us")
      })
      const ambiguous = yield* selectedPullRequest(
        [pullRequest, regionalPullRequest],
        pullRequest.account.profile,
        pullRequest.id
      ).pipe(Effect.flip)
      expect(ambiguous.message).toContain("ambiguous")

      const cached = Schema.encodeSync(PRService.CachedPRToPullRequest)(regionalPullRequest)
      const first = Schema.encodeSync(PRService.CachedPRToPullRequest)(pullRequest)
      const cache = { findAll: () => Effect.succeed([first, cached]) }
      const token = encodePullRequestCoordinates({
        accountId: pullRequest.account.profile,
        pullRequestId: regionalPullRequest.id,
        repositoryName: regionalPullRequest.repositoryName,
        region: regionalPullRequest.account.region
      })

      const selected = yield* cachedPullRequest(cache, token, regionalPullRequest.id)
      expect(selected.repositoryName).toBe(regionalPullRequest.repositoryName)
      expect(selected.account.region).toBe(regionalPullRequest.account.region)

      const invalidToken = yield* cachedPullRequest(cache, "ccpr:not-json", regionalPullRequest.id).pipe(Effect.flip)
      expect(invalidToken.message).toContain("not available")

      const whitespaceAccountToken = `cc1_${
        Encoding.encodeBase64Url(JSON.stringify([
          "  production  ",
          String(regionalPullRequest.id),
          `  ${String(regionalPullRequest.repositoryName)}  `,
          `  ${String(regionalPullRequest.account.region)}  `
        ]))
      }`
      const whitespaceCoordinates = yield* decodePullRequestCoordinates(whitespaceAccountToken)
      expect(whitespaceCoordinates._tag).toBe("Some")
      if (whitespaceCoordinates._tag === "Some") {
        expect(whitespaceCoordinates.value).toMatchObject({
          accountId: "production",
          repositoryName: String(regionalPullRequest.repositoryName),
          region: String(regionalPullRequest.account.region)
        })
      }

      const emptyPartToken = `cc1_${
        Encoding.encodeBase64Url(JSON.stringify([
          "production",
          String(regionalPullRequest.id),
          "   ",
          String(regionalPullRequest.account.region)
        ]))
      }`
      const emptyPartCoordinates = yield* decodePullRequestCoordinates(emptyPartToken)
      expect(emptyPartCoordinates._tag).toBe("None")

      const jsonScalarProfile = `cc1_${Encoding.encodeBase64Url(JSON.stringify(123))}`
      const scalarCoordinates = yield* decodePullRequestCoordinates(jsonScalarProfile)
      expect(scalarCoordinates._tag).toBe("None")
      const scalarProfile = new Domain.PullRequest({
        ...pullRequest,
        account: new Domain.Account({
          profile: Domain.AwsProfileName.make(jsonScalarProfile),
          region: pullRequest.account.region,
          awsAccountId: undefined,
          repoAccountId: undefined
        })
      })
      const selectedScalarProfile = yield* cachedPullRequest(
        { findAll: () => Effect.succeed([Schema.encodeSync(PRService.CachedPRToPullRequest)(scalarProfile)]) },
        jsonScalarProfile,
        scalarProfile.id,
        { repositoryName: "payments", region: "eu-west-1" }
      )
      expect(selectedScalarProfile.account.profile).toBe(jsonScalarProfile)
    }))

  it.effect("binds coordinate tokens to the credential account, not repository ownership", () =>
    Effect.gen(function*() {
      const intended = new Domain.PullRequest({
        ...pullRequest,
        account: new Domain.Account({
          profile: Domain.AwsProfileName.make("credential-profile"),
          region: Domain.AwsRegion.make("eu-west-1"),
          awsAccountId: "credential-account",
          repoAccountId: "repository-account"
        })
      })
      const foreign = new Domain.PullRequest({
        ...intended,
        account: new Domain.Account({
          profile: Domain.AwsProfileName.make("foreign-profile"),
          region: intended.account.region,
          awsAccountId: "foreign-account",
          repoAccountId: "credential-account"
        })
      })
      const coordinates = {
        accountId: "credential-account",
        pullRequestId: intended.id,
        repositoryName: intended.repositoryName,
        region: intended.account.region
      }
      const selected = yield* selectedPullRequest([intended, foreign], "credential-account", intended.id, coordinates)
      expect(selected).toBe(intended)

      const profileCollision = new Domain.PullRequest({
        ...foreign,
        account: new Domain.Account({
          ...foreign.account,
          profile: Domain.AwsProfileName.make("credential-account")
        })
      })
      const rejectedProfileCollision = yield* selectedPullRequest(
        [profileCollision],
        "credential-account",
        intended.id,
        coordinates
      ).pipe(Effect.flip)
      expect(rejectedProfileCollision.message).toContain("not available")
    }))

  it.effect("carries exact coordinates through a refresh route", () =>
    Effect.gen(function*() {
      const token = encodePullRequestCoordinates({
        accountId: "111122223333",
        pullRequestId: pullRequest.id,
        repositoryName: pullRequest.repositoryName,
        region: pullRequest.account.region
      })
      const fromToken = yield* refreshRouteCoordinates(token, pullRequest.id, {})
      expect(fromToken).toEqual({
        accountId: "111122223333",
        coordinates: {
          repositoryName: "payments",
          region: "eu-west-1"
        }
      })

      const fromQuery = yield* refreshRouteCoordinates("111122223333", pullRequest.id, {
        repositoryName: "payments",
        region: pullRequest.account.region
      })
      expect(fromQuery.coordinates).toEqual({ repositoryName: "payments", region: "eu-west-1" })
    }))

  it("keeps provider-valid maximum repository tokens inside the router bound", () => {
    const token = encodePullRequestCoordinates({
      accountId: "a".repeat(128),
      pullRequestId: Domain.PullRequestId.make("p".repeat(128)),
      repositoryName: Domain.RepositoryName.make("r".repeat(100)),
      region: Domain.AwsRegion.make("e".repeat(64))
    })
    expect(token.length).toBeLessThanOrEqual(coordinateRouterMaxParamLength)
    expect(() =>
      encodePullRequestCoordinates({
        accountId: "a".repeat(181),
        pullRequestId: Domain.PullRequestId.make("42"),
        repositoryName: Domain.RepositoryName.make("payments"),
        region: Domain.AwsRegion.make("eu-west-1")
      })
    ).toThrow()
  })
})
