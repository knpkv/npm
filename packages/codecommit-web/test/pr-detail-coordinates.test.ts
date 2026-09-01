import { describe, expect, it } from "@effect/vitest"
import * as Domain from "@knpkv/codecommit-core/Domain.js"

import {
  matchesPullRequestSandbox,
  pullRequestRefreshKey,
  pullRequestSandboxAccountId
} from "../src/client/pr-detail-coordinates.js"

const pullRequest = new Domain.PullRequest({
  account: new Domain.Account({
    awsAccountId: "credential-account",
    profile: "production",
    region: "eu-west-1",
    repoAccountId: "repository-account"
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

const sandbox = {
  awsAccountId: "credential-account",
  id: "sandbox-payments",
  lastActivityAt: "2026-08-12T09:30:00.000Z",
  pullRequestId: "42",
  region: "eu-west-1",
  repositoryName: "payments",
  status: "running"
}

describe("PR detail provider coordinates", () => {
  it("keeps recovery requests distinct when only repository or region changes", () => {
    const base = pullRequestRefreshKey("credential-account", "42", {
      region: "eu-west-1",
      repositoryName: "payments"
    })

    expect(pullRequestRefreshKey("credential-account", "42", {
      region: "us-east-1",
      repositoryName: "payments"
    })).not.toBe(base)
    expect(pullRequestRefreshKey("credential-account", "42", {
      region: "eu-west-1",
      repositoryName: "other"
    })).not.toBe(base)
    expect(pullRequestRefreshKey("credential-account", "42", undefined)).not.toBe(base)
  })

  it("reuses only a sandbox with the complete PR identity", () => {
    expect(matchesPullRequestSandbox(sandbox, pullRequest)).toBe(true)
    expect(matchesPullRequestSandbox({ ...sandbox, repositoryName: "other" }, pullRequest)).toBe(false)
    expect(matchesPullRequestSandbox({ ...sandbox, region: "us-east-1" }, pullRequest)).toBe(false)
    expect(matchesPullRequestSandbox({ ...sandbox, status: "stopped" }, pullRequest)).toBe(false)
  })

  it("uses the creation identity when the credential account is absent", () => {
    expect(pullRequestSandboxAccountId(
      new Domain.Account({
        awsAccountId: undefined,
        profile: "production",
        region: "eu-west-1",
        repoAccountId: "repository-account"
      })
    )).toBe("production")
  })
})
