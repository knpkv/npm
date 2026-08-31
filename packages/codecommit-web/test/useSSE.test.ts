import { describe, expect, it } from "@effect/vitest"
import { decodeSseState } from "../src/client/hooks/useSSE.js"

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
