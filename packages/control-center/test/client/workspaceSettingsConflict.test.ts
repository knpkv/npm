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

  it("keeps dependent agent fields coherent when concurrent edits cross", () => {
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
        allowedProviders: ["codex"]
      }
    })
    const latest = WorkspaceSettingsV1.make({
      ...base,
      agent: {
        ...base.agent,
        defaultProvider: "claude"
      }
    })

    const recovered = reapplyValidWorkspaceSettingsCandidate(base, candidate, latest)

    assert.deepStrictEqual(recovered.agent.allowedProviders, ["codex"])
    assert.strictEqual(recovered.agent.defaultProvider, "codex")
  })

  it("keeps dependent retention and synchronization fields coherent", () => {
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
    const recoveredRetention = reapplyValidWorkspaceSettingsCandidate(
      retentionBase,
      retentionCandidate,
      retentionLatest
    )

    assert.strictEqual(recoveredRetention.retention.evidenceDays, 100)
    assert.strictEqual(recoveredRetention.retention.auditDays, 100)

    const synchronizationCandidate = WorkspaceSettingsV1.make({
      ...DEFAULT_WORKSPACE_SETTINGS,
      synchronization: {
        cadence: "interval",
        intervalMinutes: 30,
        staleAfterMinutes: DEFAULT_WORKSPACE_SETTINGS.synchronization.staleAfterMinutes
      }
    })
    const synchronizationLatest = WorkspaceSettingsV1.make({
      ...DEFAULT_WORKSPACE_SETTINGS,
      synchronization: {
        ...DEFAULT_WORKSPACE_SETTINGS.synchronization,
        staleAfterMinutes: 60
      }
    })
    const recoveredSynchronization = reapplyValidWorkspaceSettingsCandidate(
      DEFAULT_WORKSPACE_SETTINGS,
      synchronizationCandidate,
      synchronizationLatest
    )

    assert.strictEqual(recoveredSynchronization.synchronization.cadence, "interval")
    assert.strictEqual(recoveredSynchronization.synchronization.intervalMinutes, 30)
    assert.strictEqual(
      recoveredSynchronization.synchronization.staleAfterMinutes,
      DEFAULT_WORKSPACE_SETTINGS.synchronization.staleAfterMinutes
    )
  })
})
