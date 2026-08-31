import { describe, expect, it } from "@effect/vitest"
import { Domain } from "@knpkv/codecommit-core"

import { reviewApiAccountId, sandboxMatchesPullRequest } from "../src/client/components/pr-detail.js"

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

  it("gives review APIs a validated account-coordinate token", () => {
    const token = reviewApiAccountId(pullRequest)
    expect(token.startsWith("ccpr:")).toBe(true)
    expect(token).not.toBe("111122223333")
  })
})
