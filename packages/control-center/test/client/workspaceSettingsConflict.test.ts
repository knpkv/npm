import { assert, describe, it } from "@effect/vitest"

import { reapplyWorkspaceSettingsCandidate } from "../../src/client/settings/useWorkspaceSettings.js"
import { DEFAULT_WORKSPACE_SETTINGS, type WorkspaceSettingsV1 } from "../../src/domain/workspaceSettings.js"

describe("workspace settings conflict recovery", () => {
  it("reapplies only locally changed fields over the latest document", () => {
    const candidate: WorkspaceSettingsV1 = {
      ...DEFAULT_WORKSPACE_SETTINGS,
      presentation: {
        ...DEFAULT_WORKSPACE_SETTINGS.presentation,
        density: "compact"
      }
    }
    const latest: WorkspaceSettingsV1 = {
      ...DEFAULT_WORKSPACE_SETTINGS,
      presentation: {
        ...DEFAULT_WORKSPACE_SETTINGS.presentation,
        defaultLanding: "active-work"
      }
    }

    const recovered = reapplyWorkspaceSettingsCandidate(
      DEFAULT_WORKSPACE_SETTINGS,
      candidate,
      latest
    )

    assert.strictEqual(recovered.presentation.density, "compact")
    assert.strictEqual(recovered.presentation.defaultLanding, "active-work")
  })
})
