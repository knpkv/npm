import { describe, expect, it } from "@effect/vitest"
import { Domain } from "@knpkv/codecommit-core"
import { prListHref, prListKey } from "../src/client/components/pr-list.js"

describe("PR list links", () => {
  it("retains repository and region coordinates for duplicate PR identifiers", () => {
    const pullRequest = {
      account: new Domain.Account({
        profile: Domain.AwsProfileName.make("production"),
        region: Domain.AwsRegion.make("eu-west-1"),
        awsAccountId: "111122223333",
        repoAccountId: "111122223333"
      }),
      id: Domain.PullRequestId.make("42"),
      repositoryName: Domain.RepositoryName.make("payments")
    }
    const href = prListHref(pullRequest)

    expect(href).toBe(
      "/accounts/111122223333/prs/42?repository=payments&region=eu-west-1"
    )

    expect(prListKey(pullRequest)).toBe("111122223333:42:payments:eu-west-1")
    expect(prListKey({
      ...pullRequest,
      account: new Domain.Account({
        profile: Domain.AwsProfileName.make("production"),
        region: Domain.AwsRegion.make("us-east-1"),
        awsAccountId: "111122223333",
        repoAccountId: "111122223333"
      }),
      repositoryName: Domain.RepositoryName.make("orders")
    })).not.toBe(prListKey(pullRequest))
  })
})
