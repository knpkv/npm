/**
 * Unit tests for deciding which open PR a checked-out branch belongs to.
 *
 * Fixtures go through `Schema.decodeSync(PullRequest)` so they are real branded
 * domain objects rather than casts.
 */
import { describe, expect, it } from "@effect/vitest"
import { PullRequest } from "@knpkv/codecommit-core/Domain.js"
import { Schema } from "effect"
import { matchOpenPullRequest } from "../src/OpenPullRequest.js"

const pullRequest = (o: {
  readonly id: string
  readonly lastModifiedDate: string
  readonly repositoryName: string
  readonly sourceBranch: string
}): PullRequest =>
  Schema.decodeSync(PullRequest)({
    id: o.id,
    title: "Add feature",
    author: "alice",
    repositoryName: o.repositoryName,
    creationDate: new Date("2026-08-01"),
    lastModifiedDate: new Date(o.lastModifiedDate),
    link: "https://console.aws.amazon.com",
    account: { profile: "core-code-awscodecommitpoweruser", region: "eu-central-1" },
    status: "OPEN",
    sourceBranch: o.sourceBranch,
    destinationBranch: "main",
    isMergeable: true,
    isApproved: false,
    approvedBy: [],
    commentedBy: [],
    approvalRules: []
  })

describe("matchOpenPullRequest", () => {
  const target = { branch: "feat/RPS-2335-thing", repositoryName: "identity" }

  it("finds nothing when no PR sources the branch", () => {
    expect(
      matchOpenPullRequest(
        [pullRequest({ id: "1", lastModifiedDate: "2026-08-01", repositoryName: "identity", sourceBranch: "main" })],
        target
      )
    ).toBeNull()
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
    ).toBeNull()
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

    expect(match?.id).toBe("new")
  })
})
