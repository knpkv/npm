import { describe, expect, it } from "@effect/vitest"
import { decodeSseState } from "../src/client/hooks/useSSE.js"
import { queuePullRequests } from "../src/client/utils/queuePullRequests.js"

describe("SSE sandbox coordinates", () => {
  it("preserves the sandbox region from the wire snapshot", () => {
    const state = decodeSseState(JSON.stringify({
      pullRequests: [],
      accounts: [],
      status: "idle",
      pendingReviewCount: 0,
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
      pendingReviewCount: 0,
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
