import { assert, describe, it } from "@effect/vitest"
import { Schema } from "effect"

import { reapplyWorkspaceSettingsCandidate } from "../../src/client/settings/useWorkspaceSettings.js"
import { DEFAULT_WORKSPACE_SETTINGS, WorkspaceSettingsV1 } from "../../src/domain/workspaceSettings.js"

const reapplyValidWorkspaceSettingsCandidate = (
  base: WorkspaceSettingsV1,
  candidate: WorkspaceSettingsV1,
  latest: WorkspaceSettingsV1
): WorkspaceSettingsV1 => {
  const recovered = reapplyWorkspaceSettingsCandidate(base, candidate, latest)
  if (recovered === null) assert.fail("expected a schema-valid recovered document")
  assert.isTrue(Schema.is(WorkspaceSettingsV1)(recovered))
  return recovered
}

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

    const recovered = reapplyValidWorkspaceSettingsCandidate(
      DEFAULT_WORKSPACE_SETTINGS,
      candidate,
      latest
    )

    assert.strictEqual(recovered.presentation.density, "compact")
    assert.strictEqual(recovered.presentation.defaultLanding, "active-work")
  })

  it("preserves unrelated remote agent changes while reapplying a local field", () => {
    const base = WorkspaceSettingsV1.make({
      ...DEFAULT_WORKSPACE_SETTINGS,
      agent: {
        ...DEFAULT_WORKSPACE_SETTINGS.agent,
        allowedProviders: ["claude", "codex"],
        defaultProvider: "codex"
      }
    })
    const candidate = WorkspaceSettingsV1.make({
      ...base,
      agent: {
        ...base.agent,
        toolPolicy: "review-sandbox"
      }
    })
    const latest = WorkspaceSettingsV1.make({
      ...base,
      agent: {
        ...base.agent,
        allowedProviders: ["claude"],
        defaultProvider: "claude"
      }
    })

    const recovered = reapplyValidWorkspaceSettingsCandidate(base, candidate, latest)

    assert.deepStrictEqual(recovered.agent.allowedProviders, ["claude"])
    assert.strictEqual(recovered.agent.defaultProvider, "claude")
    assert.strictEqual(recovered.agent.toolPolicy, "review-sandbox")
  })

  it("leaves schema-invalid dependent cross-edits unresolved", () => {
    const agentBase = WorkspaceSettingsV1.make({
      ...DEFAULT_WORKSPACE_SETTINGS,
      agent: {
        ...DEFAULT_WORKSPACE_SETTINGS.agent,
        allowedProviders: ["claude", "codex"],
        defaultProvider: "codex"
      }
    })
    const agentCandidate = WorkspaceSettingsV1.make({
      ...agentBase,
      agent: {
        ...agentBase.agent,
        allowedProviders: ["codex"]
      }
    })
    const agentLatest = WorkspaceSettingsV1.make({
      ...agentBase,
      agent: {
        ...agentBase.agent,
        defaultProvider: "claude"
      }
    })

    assert.isNull(
      reapplyWorkspaceSettingsCandidate(agentBase, agentCandidate, agentLatest)
    )

    const retentionBase = WorkspaceSettingsV1.make({
      ...DEFAULT_WORKSPACE_SETTINGS,
      retention: {
        ...DEFAULT_WORKSPACE_SETTINGS.retention,
        evidenceDays: 100
      }
    })
    const retentionCandidate = WorkspaceSettingsV1.make({
      ...retentionBase,
      retention: {
        ...retentionBase.retention,
        auditDays: 100
      }
    })
    const retentionLatest = WorkspaceSettingsV1.make({
      ...retentionBase,
      retention: {
        ...retentionBase.retention,
        evidenceDays: 365
      }
    })

    assert.isNull(
      reapplyWorkspaceSettingsCandidate(retentionBase, retentionCandidate, retentionLatest)
    )

    const synchronizationBase = WorkspaceSettingsV1.make({
      ...DEFAULT_WORKSPACE_SETTINGS,
      synchronization: {
        cadence: "interval",
        intervalMinutes: 30,
        staleAfterMinutes: DEFAULT_WORKSPACE_SETTINGS.synchronization.staleAfterMinutes
      }
    })
    const synchronizationCandidate = WorkspaceSettingsV1.make({
      ...synchronizationBase,
      synchronization: {
        ...synchronizationBase.synchronization,
        intervalMinutes: 60
      }
    })
    const synchronizationLatest = WorkspaceSettingsV1.make({
      ...synchronizationBase,
      synchronization: {
        ...synchronizationBase.synchronization,
        cadence: "manual",
        intervalMinutes: null
      }
    })

    assert.isNull(
      reapplyWorkspaceSettingsCandidate(
        synchronizationBase,
        synchronizationCandidate,
        synchronizationLatest
      )
    )
  })
})
