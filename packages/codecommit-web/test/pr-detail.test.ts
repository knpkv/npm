import { describe, expect, it } from "@effect/vitest"
import { Domain } from "@knpkv/codecommit-core"

import {
  commentNavigationIdentityForCoordinates,
  reviewApiAccountId,
  sandboxAccountIdForPullRequest,
  sandboxMatchesPullRequest,
  selectCodeCommitPullRequest
} from "../src/client/components/pr-detail.js"

const pullRequest = new Domain.PullRequest({
  account: new Domain.Account({
    profile: Domain.AwsProfileName.make("production"),
    region: Domain.AwsRegion.make("eu-west-1"),
    awsAccountId: "111122223333",
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

describe("PR detail coordinates", () => {
  it("isolates comment state by the complete PR coordinate", () => {
    const payment = commentNavigationIdentityForCoordinates("111122223333", "42", "payments", "eu-west-1")
    const orders = commentNavigationIdentityForCoordinates("111122223333", "42", "orders", "eu-west-1")
    const otherRegion = commentNavigationIdentityForCoordinates("111122223333", "42", "payments", "us-east-1")

    expect(payment).not.toBe(orders)
    expect(payment).not.toBe(otherRegion)
    expect(payment).toBe(commentNavigationIdentityForCoordinates("111122223333", "42", "payments", "eu-west-1"))
  })

  it("does not reuse a sandbox from another repository or region", () => {
    const sandbox = {
      awsAccountId: "111122223333",
      pullRequestId: "42",
      repositoryName: "payments-us",
      region: "us-east-1"
    }

    expect(sandboxMatchesPullRequest(sandbox, pullRequest)).toBe(false)
    expect(
      sandboxMatchesPullRequest(
        { ...sandbox, repositoryName: "payments", region: "eu-west-1" },
        pullRequest
      )
    ).toBe(true)
  })

  it("keeps the profile as the sandbox identity after account discovery", () => {
    expect(sandboxAccountIdForPullRequest(pullRequest)).toBe("production")
    expect(
      sandboxMatchesPullRequest(
        { awsAccountId: "production", pullRequestId: "42", repositoryName: "payments", region: "eu-west-1" },
        pullRequest
      )
    ).toBe(true)
  })

  it("uses the profile for sandbox identity when the account id is empty", () => {
    const profilePullRequest = new Domain.PullRequest({
      ...pullRequest,
      account: new Domain.Account({
        ...pullRequest.account,
        awsAccountId: ""
      })
    })

    expect(
      sandboxMatchesPullRequest(
        { awsAccountId: "production", pullRequestId: "42", repositoryName: "payments", region: "eu-west-1" },
        profilePullRequest
      )
    ).toBe(true)
    expect(
      sandboxMatchesPullRequest(
        { awsAccountId: "", pullRequestId: "42", repositoryName: "payments", region: "eu-west-1" },
        profilePullRequest
      )
    ).toBe(false)
  })

  it("gives review APIs a validated account-coordinate token", () => {
    const token = reviewApiAccountId(pullRequest)
    expect(token.startsWith("cc1_")).toBe(true)
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(token.length).toBeLessThan(100)
    expect(token).not.toBe("111122223333")
  })

  it("does not select an arbitrary cached PR from an ambiguous legacy route", () => {
    const other = new Domain.PullRequest({
      ...pullRequest,
      repositoryName: Domain.RepositoryName.make("orders"),
      account: new Domain.Account({
        ...pullRequest.account,
        region: Domain.AwsRegion.make("us-east-1")
      })
    })

    const ambiguous = selectCodeCommitPullRequest([pullRequest, other], {
      accountId: "111122223333",
      pullRequestId: "42"
    })
    expect(ambiguous).toEqual({ pullRequest: null, ambiguous: true })

    const exact = selectCodeCommitPullRequest([pullRequest, other], {
      accountId: "111122223333",
      pullRequestId: "42",
      repositoryName: "orders",
      region: "us-east-1"
    })
    expect(exact).toEqual({ pullRequest: other, ambiguous: false })
  })
})
