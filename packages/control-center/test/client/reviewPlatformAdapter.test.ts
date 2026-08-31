import { describe, expect, it } from "vitest"
import { AgentModelId, DurableAgentProviderId, ReviewAgentProfileId } from "../../src/api/agent.js"
import {
  controlCenterReviewProfile,
  controlCenterReviewThread
} from "../../src/client/entities/reviewPlatformAdapter.js"
import { EntityId } from "../../src/domain/identifiers.js"

describe("Control Center review platform adapter", () => {
  it("maps only browser-safe execution metadata", () => {
    expect(
      controlCenterReviewProfile({
        providerId: DurableAgentProviderId.make("codex"),
        model: AgentModelId.make("gpt-5.6-sol"),
        reviewProfile: {
          profileId: ReviewAgentProfileId.make("codex:review:sbx"),
          label: "Codex review",
          budgetMillis: 1_200_000,
          networkAccess: "provider-enabled",
          sandbox: "sbx"
        }
      })
    ).toEqual({
      id: "codex",
      name: "codex",
      kind: "review",
      provider: "codex",
      harness: "sbx",
      model: "gpt-5.6-sol",
      skillIds: []
    })
  })

  it("binds thread identity to the exact entity session and revision", () => {
    expect(
      controlCenterReviewThread({
        baseRevision: "base-1",
        entityId: EntityId.make("01890f6f-6d6a-7cc0-98d2-000000000701"),
        headRevision: "head-1",
        sessionKey: "session-1"
      })
    ).toEqual({
      namespace: "control-center",
      subjectId: "01890f6f-6d6a-7cc0-98d2-000000000701",
      revisionId: "session-1",
      baseRevision: "base-1",
      headRevision: "head-1"
    })
  })
})
