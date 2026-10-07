import { describe, expect, it } from "@effect/vitest"
import { approvalOf, PullRequest } from "@knpkv/codecommit-core/Domain.js"
import { Schema } from "effect"
import { decodeSseState } from "../src/client/hooks/useSSE.js"
import { queuePullRequests } from "../src/client/utils/queuePullRequests.js"
import { CachedPullRequestResponse } from "../src/server/Api.js"

describe("SSE sandbox coordinates", () => {
  it("preserves the sandbox region from the wire snapshot", () => {
    const state = decodeSseState(JSON.stringify({
      pullRequests: [],
      accounts: [],
      status: "idle",
      sandboxes: [{
        id: "sandbox-1",
        pullRequestId: "42",
        awsAccountId: "123456789012",
        region: "eu-west-1",
        repositoryName: "payments",
        sourceBranch: "feature",
        containerId: null,
        port: null,
        status: "running",
        statusDetail: null,
        logs: null,
        error: null,
        createdAt: "2026-08-01T00:00:00.000Z",
        lastActivityAt: "2026-08-01T00:00:00.000Z"
      }]
    }))

    expect(state.sandboxes?.[0]?.region).toBe("eu-west-1")
  })
})

describe("SSE account visibility", () => {
  const snapshot = (enabledProfiles?: ReadonlyArray<string>) =>
    JSON.stringify({
      pullRequests: [
        {
          id: "11",
          title: "Kept",
          author: "reviewer",
          repositoryName: "payments",
          creationDate: "2026-08-01T00:00:00.000Z",
          lastModifiedDate: "2026-08-02T00:00:00.000Z",
          link: "https://example.invalid/pr/11",
          account: { profile: "kept-profile", region: "eu-west-1" },
          status: "OPEN",
          sourceBranch: "feature",
          destinationBranch: "main",
          isMergeable: true,
          isApproved: false,
          approvedBy: [],
          approvedByArns: [],
          commentedBy: [],
          approvalRules: []
        },
        {
          id: "22",
          title: "Switched off",
          author: "reviewer",
          repositoryName: "payments",
          creationDate: "2026-08-01T00:00:00.000Z",
          lastModifiedDate: "2026-08-02T00:00:00.000Z",
          link: "https://example.invalid/pr/22",
          account: { profile: "switched-off-profile", region: "eu-west-1" },
          status: "OPEN",
          sourceBranch: "feature",
          destinationBranch: "main",
          isMergeable: true,
          isApproved: false,
          approvedBy: [],
          approvedByArns: [],
          commentedBy: [],
          approvalRules: []
        }
      ],
      // Detection found nothing — the case that must not decide visibility.
      accounts: [],
      status: "idle",
      ...(enabledProfiles !== undefined && { enabledProfiles })
    })

  it("carries the server's enabled accounts through to the queue", () => {
    const state = decodeSseState(snapshot(["kept-profile"]))

    expect(state.enabledProfiles).toEqual(["kept-profile"])
    // The whole cache stays in state so a PR detail URL still resolves; only the
    // queue drops the switched-off account.
    expect(state.pullRequests.map((pr) => String(pr.id))).toEqual(["11", "22"])
    expect(queuePullRequests(state).map((pr) => String(pr.id))).toEqual(["11"])
  })

  it("lists everything when the server could not read which accounts are on", () => {
    const state = decodeSseState(snapshot())

    expect(state.enabledProfiles).toBeUndefined()
    expect(queuePullRequests(state).map((pr) => String(pr.id))).toEqual(["11", "22"])
  })
})

describe("SSE approval unknown", () => {
  it("keeps a pull request's unknown approval from the server's encoding through the client's own schema", () => {
    // The server's payload encodes pull requests with the domain schema.
    const sent = Schema.encodeSync(PullRequest)(
      Schema.decodeSync(PullRequest)({
        id: "33",
        title: "Unknown approval",
        author: "reviewer",
        repositoryName: "payments",
        creationDate: new Date("2026-08-01T00:00:00.000Z"),
        lastModifiedDate: new Date("2026-08-02T00:00:00.000Z"),
        link: "https://example.invalid/pr/33",
        account: { profile: "kept-profile", region: "eu-west-1" },
        status: "OPEN",
        sourceBranch: "feature",
        destinationBranch: "main",
        isMergeable: true,
        isApproved: true,
        approvalUnknown: { _tag: "NotPermitted" },
        approvedBy: [],
        commentedBy: []
      })
    )
    const state = decodeSseState(JSON.stringify({ pullRequests: [sent], accounts: [], status: "idle" }))

    expect(state.pullRequests.map(approvalOf)).toEqual([{ _tag: "Unknown", reason: { _tag: "NotPermitted" } }])
  })

  it("keeps the unknown reason on a cached pull-request row the API returns", () => {
    const row = Schema.decodeSync(CachedPullRequestResponse)({
      id: "33",
      awsAccountId: "123456789012",
      accountProfile: "kept-profile",
      accountRegion: "eu-west-1",
      title: "Unknown approval",
      description: null,
      author: "reviewer",
      repositoryName: "payments",
      creationDate: "2026-08-01T00:00:00.000Z",
      lastModifiedDate: "2026-08-02T00:00:00.000Z",
      status: "OPEN",
      sourceBranch: "feature",
      destinationBranch: "main",
      isMergeable: 1,
      isApproved: 1,
      approvalUnknownReason: "Throttled",
      commentCount: null,
      link: "https://example.invalid/pr/33",
      fetchedAt: "2026-08-02T00:00:00.000Z"
    })

    expect(Schema.encodeSync(CachedPullRequestResponse)(row).approvalUnknownReason).toBe("Throttled")
  })
})

describe("SSE caller identities", () => {
  it("keeps every account's caller identity, resolved or not, from the wire snapshot", () => {
    const callerIdentities = {
      alpha: {
        _tag: "Resolved",
        accountId: "111111111111",
        arn: "arn:aws:sts::111111111111:assumed-role/Reviewers/alice@example.com",
        username: "alice@example.com"
      },
      beta: { _tag: "Unresolved", reason: { _tag: "CredentialsUnavailable" } }
    }
    const state = decodeSseState(JSON.stringify({
      pullRequests: [],
      accounts: [],
      status: "idle",
      pendingReviewCount: 0,
      callerIdentities
    }))

    expect(state.callerIdentities).toEqual(callerIdentities)
  })
})

describe("SSE unevaluated pull requests", () => {
  it("keeps the pull requests a refresh could not re-evaluate from the wire snapshot", () => {
    const unevaluatedPullRequests = [{
      profile: "alpha",
      region: "eu-west-1",
      pullRequestId: "8",
      repositoryName: "payments",
      message: "EvaluatePullRequestApprovalRules failed for pull request 8: not authorized"
    }]
    const state = decodeSseState(JSON.stringify({
      pullRequests: [],
      accounts: [],
      status: "idle",
      unevaluatedPullRequests
    }))

    expect(state.unevaluatedPullRequests).toEqual(unevaluatedPullRequests)
  })
})
