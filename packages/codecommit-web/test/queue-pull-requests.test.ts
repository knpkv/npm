import { describe, expect, it } from "@effect/vitest"
import { Domain } from "@knpkv/codecommit-core"
import { queuePullRequests } from "../src/client/utils/queuePullRequests.js"

const pullRequest = (profile: string, id: string) =>
  new Domain.PullRequest({
    account: new Domain.Account({
      profile: Domain.AwsProfileName.make(profile),
      region: Domain.AwsRegion.make("eu-west-1"),
      awsAccountId: "111122223333"
    }),
    approvalRules: [],
    approvedBy: [],
    approvedByArns: [],
    author: "reviewer",
    commentedBy: [],
    creationDate: new Date(0),
    destinationBranch: "main",
    id: Domain.PullRequestId.make(id),
    isApproved: false,
    isMergeable: true,
    lastModifiedDate: new Date(1_000),
    link: `https://example.invalid/pr/${id}`,
    repositoryName: Domain.RepositoryName.make("payments"),
    sourceBranch: "feature",
    status: "OPEN",
    title: "Review"
  })

const pullRequests = [pullRequest("kept-profile", "11"), pullRequest("switched-off-profile", "22")]

describe("queuePullRequests", () => {
  it("hides pull requests of accounts the user switched off", () => {
    const listed = queuePullRequests({ enabledProfiles: ["kept-profile"], pullRequests })

    expect(listed.map((pr) => String(pr.id))).toEqual(["11"])
  })

  it("lists every account that is switched on", () => {
    // Hiding is a queue concern: the rows stay cached, so re-enabling needs no
    // provider round trip and a URL naming one still resolves.
    const listed = queuePullRequests({
      enabledProfiles: ["kept-profile", "switched-off-profile"],
      pullRequests
    })

    expect(listed.map((pr) => String(pr.id))).toEqual(["11", "22"])
  })

  it("empties the queue when no account is switched on", () => {
    expect(queuePullRequests({ enabledProfiles: [], pullRequests })).toEqual([])
  })

  it("lists everything when the server could not read which accounts are on", () => {
    // Distinct from "none are on": showing one pull request too many beats
    // blanking the queue over a transient config read.
    expect(queuePullRequests({ pullRequests }).map((pr) => String(pr.id))).toEqual(["11", "22"])
  })
})
