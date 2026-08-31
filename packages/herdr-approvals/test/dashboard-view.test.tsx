import { describe, expect, it } from "@effect/vitest"
import { renderToStaticMarkup } from "react-dom/server"
import type { DashboardSnapshot } from "../src/dashboard-model.js"
import { approvalShortcutFor, DashboardView } from "../src/dashboard-view.js"

const snapshot = (approvalsEnabled: boolean): DashboardSnapshot => {
  const pending: DashboardSnapshot["records"][number] = {
    actor: "submitter@example.com",
    approvalExpiresAt: 61_000,
    approvalNonce: "nonce-1",
    approvedAt: null,
    approvedBy: null,
    createdAt: 1_000,
    error: null,
    expiredAt: null,
    hash: "hash-1",
    id: "job-1",
    payload: { kind: "nix.apply", ref: "main" },
    rejectedAt: null,
    rejectedBy: null,
    result: null,
    status: "pending_approval",
    updatedAt: 1_000
  }
  return {
    approvalApp: {
      canonical: false,
      canonicalUrl: "https://ser8.example.test/",
      chatEnabled: false,
      pushEnabled: false
    },
    approvalsEnabled,
    chat: null,
    work: null,
    directory: null,
    host: "ALPHA",
    historyNextCursor: null,
    observedAt: 1_000,
    pendingApprovals: { failures: [], local: [pending], nextCursors: [], remote: [] },
    records: [pending],
    status: {
      applyConfigured: true,
      branch: "main",
      dirty: false,
      herdr: { agents: [], available: true, error: null },
      host: "ALPHA",
      repository: "/repo",
      revision: "abc123"
    }
  }
}

const render = (approvalsEnabled: boolean): string =>
  renderToStaticMarkup(
    <DashboardView
      busyJobId={null}
      chatBusy={false}
      notificationState="disabled"
      onChatSubmit={undefined}
      onDecision={() => undefined}
      onDisableNotifications={undefined}
      onEnableNotifications={undefined}
      onRefresh={undefined}
      pull={{ distance: 0, ready: false, refreshing: false }}
      snapshot={snapshot(approvalsEnabled)}
    />
  )

const renderApprovalOnly = (): string =>
  renderToStaticMarkup(
    <DashboardView
      approvalOnly
      busyJobId={null}
      chatBusy={false}
      notificationState="disabled"
      onChatSubmit={undefined}
      onDecision={() => undefined}
      onDisableNotifications={undefined}
      onEnableNotifications={undefined}
      onRefresh={undefined}
      pull={{ distance: 0, ready: false, refreshing: false }}
      snapshot={snapshot(true)}
    />
  )

const renderApprovedFailure = (): string => {
  const approved: DashboardSnapshot["records"][number] = {
    ...snapshot(true).records[0],
    approvalExpiresAt: null,
    approvalNonce: null,
    approvedAt: 2_000,
    approvedBy: "owner@example.com",
    error: "hostd restarted while this job was running",
    status: "failed",
    updatedAt: 3_000
  }
  return renderToStaticMarkup(
    <DashboardView
      approvalOnly
      busyJobId={null}
      chatBusy={false}
      notificationState="disabled"
      onChatSubmit={undefined}
      onDecision={() => undefined}
      onDisableNotifications={undefined}
      onEnableNotifications={undefined}
      onRefresh={undefined}
      pull={{ distance: 0, ready: false, refreshing: false }}
      snapshot={{ ...snapshot(true), records: [approved] }}
    />
  )
}

const renderMixedAgentStates = (): string => {
  const agents: DashboardSnapshot["status"]["herdr"]["agents"] = [
    {
      activityRevision: 2,
      agentId: "agent-working",
      kind: "codex",
      name: "worker",
      paneId: "w1:p1",
      parentAgentId: null,
      relation: null,
      status: "working",
      work: "package migration"
    },
    {
      activityRevision: 1,
      agentId: "agent-done",
      kind: "codex",
      name: "reviewer",
      paneId: "w1:p2",
      parentAgentId: null,
      relation: null,
      status: "done",
      work: "UI review"
    }
  ]
  const base = snapshot(true)
  return renderToStaticMarkup(
    <DashboardView
      busyJobId={null}
      chatBusy={false}
      notificationState="disabled"
      onChatSubmit={undefined}
      onDecision={() => undefined}
      onDisableNotifications={undefined}
      onEnableNotifications={undefined}
      onRefresh={undefined}
      pull={{ distance: 0, ready: false, refreshing: false }}
      snapshot={{
        ...base,
        status: { ...base.status, herdr: { ...base.status.herdr, agents } }
      }}
    />
  )
}

describe("dashboard approval capability", () => {
  it("hides decisions on a non-approval listener", () => {
    expect(render(false)).not.toContain("/v1/jobs/job-1/approve")
    expect(render(false)).not.toContain("/v1/jobs/job-1/reject")
  })

  it("renders decisions on an approval listener", () => {
    expect(render(true)).toContain("/v1/jobs/job-1/approve")
    expect(render(true)).toContain("/v1/jobs/job-1/reject")
  })

  it("names the configured canonical approval hub", () => {
    expect(render(false)).toContain("Open ser8.example.test")
    expect(render(false)).not.toContain("KNPKV-SER8")
  })

  it("routes worker Connect links through the canonical hub", () => {
    const base = snapshot(false)
    const active: DashboardSnapshot["records"][number] = {
      ...base.records[0],
      approvalExpiresAt: null,
      approvalNonce: null,
      connectTarget: {
        agentId: "agent-worker",
        host: "PI",
        url: "/connect/?agent=agent-worker&host=PI"
      },
      status: "running",
      worker: {
        agentId: "agent-worker",
        host: "PI",
        name: "Worker",
        paneId: "w2:p1"
      }
    }
    const markup = renderToStaticMarkup(
      <DashboardView
        busyJobId={null}
        chatBusy={false}
        notificationState="disabled"
        onChatSubmit={undefined}
        onDecision={undefined}
        onDisableNotifications={undefined}
        onEnableNotifications={undefined}
        onRefresh={undefined}
        pull={{ distance: 0, ready: false, refreshing: false }}
        snapshot={{
          ...base,
          pendingApprovals: { failures: [], local: [], nextCursors: [], remote: [] },
          records: [active]
        }}
      />
    )
    expect(markup).toContain('href="https://ser8.example.test/connect/?agent=agent-worker&amp;host=PI"')
  })

  it("offers a continuation when older activity remains", () => {
    const continued = {
      ...snapshot(false),
      historyNextCursor: { createdAt: 1_000, id: "job-1" }
    }
    const html = renderToStaticMarkup(
      <DashboardView
        busyJobId={null}
        chatBusy={false}
        notificationState="disabled"
        onChatSubmit={undefined}
        onDecision={undefined}
        onDisableNotifications={undefined}
        onEnableNotifications={undefined}
        onLoadHistory={() => undefined}
        onRefresh={undefined}
        pull={{ distance: 0, ready: false, refreshing: false }}
        snapshot={continued}
      />
    )
    expect(html).toContain("Load earlier activity")
  })

  it("offers a continuation when more approvals remain", () => {
    const continued = {
      ...snapshot(true),
      pendingApprovals: {
        ...snapshot(true).pendingApprovals,
        nextCursors: [{ host: "ALPHA", cursor: { createdAt: 1_000, id: "job-1" } }]
      }
    }
    const html = renderToStaticMarkup(
      <DashboardView
        approvalOnly
        busyJobId={null}
        chatBusy={false}
        notificationState="disabled"
        onChatSubmit={undefined}
        onDecision={undefined}
        onDisableNotifications={undefined}
        onEnableNotifications={undefined}
        onLoadPending={() => undefined}
        onRefresh={undefined}
        pull={{ distance: 0, ready: false, refreshing: false }}
        snapshot={continued}
      />
    )
    expect(html).toContain("Load more approvals")
  })

  it("keeps agent activity and general job history out of the approval-only surface", () => {
    const markup = renderApprovalOnly()
    expect(markup).toContain("Recent approval history")
    expect(markup).not.toContain("Agent activity")
    expect(markup).not.toContain("Activity history")
  })

  it("labels the human approval decision independently from later execution failure", () => {
    const markup = renderApprovedFailure()
    expect(markup).toContain("Approved")
    expect(markup).not.toContain(">Failed<")
  })

  it("counts observed agents without calling finished agents running", () => {
    const markup = renderMixedAgentStates()
    expect(markup).toContain("2 agents")
    expect(markup).not.toContain("2 running")
  })

  it("requires a modified shortcut for approval decisions", () => {
    expect(approvalShortcutFor({ key: "Enter", modified: true, shift: false })).toBe("approve")
    expect(approvalShortcutFor({ key: "Backspace", modified: true, shift: true })).toBe("reject")
    expect(approvalShortcutFor({ key: "Enter", modified: false, shift: false })).toBeNull()
    expect(approvalShortcutFor({ key: "Backspace", modified: true, shift: false })).toBeNull()
  })

  it("makes pending approval cards focusable and shows deliberate shortcuts", () => {
    const markup = render(true)
    expect(markup).toContain('data-agenda-item=""')
    expect(markup).toContain('data-approval-host="ALPHA"')
    expect(markup).toContain('data-approval-job="job-1"')
    expect(markup).toContain('tabindex="0"')
    expect(markup).toContain('aria-label="Approval keyboard shortcuts"')
  })
})
