/**
 * Unit tests for deciding which open PR a checked-out branch belongs to.
 *
 * Fixtures go through `Schema.decodeSync(PullRequest)` so they are real branded
 * domain objects rather than casts.
 */
import { describe, expect, it } from "@effect/vitest"
import { PullRequest } from "@knpkv/codecommit-core/Domain.js"
import { Effect, Schema } from "effect"
import { matchOpenPullRequest, resolveOpenPullRequest } from "../src/OpenPullRequest.js"

const pullRequest = (o: {
  readonly id: string
  readonly lastModifiedDate: string
  readonly repositoryName: string
  readonly sourceBranch: string
  readonly profile?: string
  readonly region?: string
  readonly repoAccountId?: string
}): PullRequest => {
  const account = o.repoAccountId === undefined
    ? {
      profile: o.profile ?? "core-code-awscodecommitpoweruser",
      region: o.region ?? "eu-central-1"
    }
    : {
      profile: o.profile ?? "core-code-awscodecommitpoweruser",
      region: o.region ?? "eu-central-1",
      repoAccountId: o.repoAccountId
    }

  return Schema.decodeSync(PullRequest)({
    id: o.id,
    title: "Add feature",
    author: "alice",
    repositoryName: o.repositoryName,
    creationDate: new Date("2026-08-01"),
    lastModifiedDate: new Date(o.lastModifiedDate),
    link: "https://console.aws.amazon.com",
    account,
    status: "OPEN",
    sourceBranch: o.sourceBranch,
    destinationBranch: "main",
    isMergeable: true,
    isApproved: false,
    approvedBy: [],
    commentedBy: [],
    approvalRules: []
  })
}

describe("matchOpenPullRequest", () => {
  const target = { branch: "feat/RPS-2335-thing", repositoryName: "identity" }

  it("finds nothing when no PR sources the branch", () => {
    expect(
      matchOpenPullRequest(
        [pullRequest({ id: "1", lastModifiedDate: "2026-08-01", repositoryName: "identity", sourceBranch: "main" })],
        target
      )
    ).toEqual({ _tag: "None" })
  })

  it("ignores a same-named branch in another repository", () => {
    // The scan is repo-filtered already, but a match must not depend on that:
    // two accounts can both answer, and only one holds this repository.
    expect(
      matchOpenPullRequest(
        [
          pullRequest({
            id: "9",
            lastModifiedDate: "2026-08-01",
            repositoryName: "authorization",
            sourceBranch: target.branch
          })
        ],
        target
      )
    ).toEqual({ _tag: "None" })
  })

  it("takes the most recently touched PR when several share the source branch", () => {
    // One branch can feed two open PRs with different destinations; the one being
    // worked on is the one that moved last, not whichever the scan returned first.
    const match = matchOpenPullRequest(
      [
        pullRequest({
          id: "old",
          lastModifiedDate: "2026-08-01T09:00:00Z",
          repositoryName: "identity",
          sourceBranch: target.branch
        }),
        pullRequest({
          id: "new",
          lastModifiedDate: "2026-08-20T09:00:00Z",
          repositoryName: "identity",
          sourceBranch: target.branch
        }),
        pullRequest({
          id: "middle",
          lastModifiedDate: "2026-08-10T09:00:00Z",
          repositoryName: "identity",
          sourceBranch: target.branch
        })
      ],
      target
    )

    expect(match._tag).toBe("Matched")
    if (match._tag === "Matched") expect(match.pullRequest.id).toBe("new")
  })

  it("reports ambiguity when matching PRs belong to distinct accounts", () => {
    const match = matchOpenPullRequest(
      [
        pullRequest({
          id: "dev",
          lastModifiedDate: "2026-08-01T09:00:00Z",
          repositoryName: "identity",
          sourceBranch: target.branch,
          profile: "dev",
          repoAccountId: "111111111111"
        }),
        pullRequest({
          id: "prod",
          lastModifiedDate: "2026-08-20T09:00:00Z",
          repositoryName: "identity",
          sourceBranch: target.branch,
          profile: "prod",
          repoAccountId: "222222222222"
        })
      ],
      target
    )

    expect(match).toEqual({ _tag: "Ambiguous", targets: ["dev/eu-central-1", "prod/eu-central-1"] })
  })

  it("selects the newest destination when aliases resolve to the same account", () => {
    const match = matchOpenPullRequest(
      [
        pullRequest({
          id: "old",
          lastModifiedDate: "2026-08-01T09:00:00Z",
          repositoryName: "identity",
          sourceBranch: target.branch,
          profile: "dev",
          repoAccountId: "111111111111"
        }),
        pullRequest({
          id: "new",
          lastModifiedDate: "2026-08-20T09:00:00Z",
          repositoryName: "identity",
          sourceBranch: target.branch,
          profile: "dev-admin",
          repoAccountId: "111111111111"
        })
      ],
      target
    )

    expect(match._tag).toBe("Matched")
    if (match._tag === "Matched") expect(match.pullRequest.id).toBe("new")
  })

  it.effect("refuses a match when another planned account could not be searched", () =>
    Effect.gen(function*() {
      const error = yield* resolveOpenPullRequest({
        failures: ["prod/eu-central-1: credentials expired"],
        pullRequests: [
          pullRequest({
            id: "dev",
            lastModifiedDate: "2026-08-01T09:00:00Z",
            repositoryName: "identity",
            sourceBranch: target.branch,
            profile: "dev"
          })
        ],
        target,
        targetCount: 2
      }).pipe(Effect.flip)

      expect(error._tag).toBe("IncompleteOpenPullRequestScan")
    }))
})
