import { describe, expect, it } from "@effect/vitest"
import { Domain } from "@knpkv/codecommit-core"
import { Effect } from "effect"

import { selectedPullRequest } from "../src/server/handlers/prs-live.js"

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

describe("PR handler selection", () => {
  it.effect("matches the repository account identifier used by browser routes", () =>
    Effect.gen(function*() {
      const selected = yield* selectedPullRequest([pullRequest], "111122223333", pullRequest.id)
      expect(selected).toBe(pullRequest)

      const failure = yield* selectedPullRequest([pullRequest], "999900001111", pullRequest.id).pipe(Effect.flip)
      expect(failure.message).toContain("not available")
    }))
})
