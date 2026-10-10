import { describe, expect, it } from "@effect/vitest"
import { Schema } from "effect"
import { PendingApprovalTarget } from "../src/dashboard-model.js"

describe("dashboard model", () => {
  it("round-trips local and remote pending approval targets", () => {
    const targets = [
      {
        _tag: "local",
        record: {
          actor: "andrey@example.com",
          approvedBy: null,
          createdAt: 1,
          id: "job-1",
          payload: { kind: "nix.check" },
          approvalAvailable: true,
          status: "pending_approval",
          updatedAt: 1
        }
      },
      {
        _tag: "remote",
        remote: {
          approval: {
            actor: "andrey@example.com",
            approvalExpiresAt: null,
            createdAt: 1,
            id: "job-2",
            payload: { kind: "nix.check" },
            status: "pending_approval"
          },
          approvalUrl: "https://ser8.example.test/",
          host: "SER8"
        }
      }
    ]

    for (const target of targets) {
      const decoded = Schema.decodeUnknownSync(PendingApprovalTarget)(target)
      expect(Schema.encodeSync(PendingApprovalTarget)(decoded)).toEqual(target)
    }
  })
})
