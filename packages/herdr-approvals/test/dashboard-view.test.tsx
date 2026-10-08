import { describe, expect, it } from "@effect/vitest"
import { renderToStaticMarkup } from "react-dom/server"
import type { DashboardSnapshot } from "../src/dashboard-model.js"
import { approvalShortcutFor, DashboardView } from "../src/dashboard-view.js"
import { dashboardPage } from "../src/internal/dashboard-page.js"

/** The pending job every snapshot starts from. */
const pendingRecord: DashboardSnapshot["records"][number] = {
  actor: "submitter@example.com",
  approvalExpiresAt: 61_000,
  approvedAt: null,
  approvedBy: null,
  createdAt: 1_000,
  expiredAt: null,
  id: "job-1",
  payload: { kind: "nix.apply", ref: "main" },
  approvalAvailable: true,
  rejectedAt: null,
  rejectedBy: null,
  status: "pending_approval",
  updatedAt: 1_000
}

const snapshot = (approvalsEnabled: boolean): DashboardSnapshot => {
  const pending = pendingRecord
  return {
    approvalApp: {
      canonical: false,
      canonicalUrl: "https://ser8.example.test/",
      pushEnabled: false,
      workEnabled: false
    },
    approvalsEnabled,
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
      notificationState="disabled"
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
      notificationState="disabled"
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
    ...pendingRecord,
    approvalExpiresAt: null,
    approvalAvailable: false,
    approvedAt: 2_000,
    approvedBy: "owner@example.com",
    status: "failed",
    updatedAt: 3_000
  }
  return renderToStaticMarkup(
    <DashboardView
      approvalOnly
      busyJobId={null}
      notificationState="disabled"
      onDecision={() => undefined}
      onDisableNotifications={undefined}
      onEnableNotifications={undefined}
      onRefresh={undefined}
      pull={{ distance: 0, ready: false, refreshing: false }}
      snapshot={{ ...snapshot(true), records: [approved] }}
    />
  )
}

type HostAgent = DashboardSnapshot["status"]["herdr"]["agents"][number]

const workingAgent: HostAgent = {
  activityRevision: 2,
  agentId: "agent-working",
  kind: "codex",
  name: "worker",
  paneId: "w1:p1",
  parentAgentId: null,
  relation: null,
  status: "working",
  work: "package migration"
}

const mixedAgents: ReadonlyArray<HostAgent> = [
  workingAgent,
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

const renderMixedAgentStates = (herdr: Partial<DashboardSnapshot["status"]["herdr"]> = {}): string => {
  const base = snapshot(true)
  return renderToStaticMarkup(
    <DashboardView
      busyJobId={null}
      notificationState="disabled"
      onDecision={() => undefined}
      onDisableNotifications={undefined}
      onEnableNotifications={undefined}
      onRefresh={undefined}
      pull={{ distance: 0, ready: false, refreshing: false }}
      snapshot={{
        ...base,
        status: { ...base.status, herdr: { ...base.status.herdr, agents: mixedAgents, ...herdr } }
      }}
    />
  )
}

describe("dashboard agent states", () => {
  it("spins only the working agent's state; a done agent keeps a still icon", () => {
    const markup = renderMixedAgentStates()
    expect(markup.match(/agent-state-spinning/g)).toHaveLength(1)
    const done = markup.slice(markup.indexOf("reviewer"))
    expect(done.slice(0, done.indexOf("</section>"))).not.toContain("agent-state-spinning")
  })
})

describe("dashboard approval capability", () => {
  it("shows the existing-owner reconciliation title and summary", () => {
    const base = snapshot(true)
    const pending: DashboardSnapshot["records"][number] = {
      ...pendingRecord,
      payload: {
        kind: "work.reconcile",
        repository: "knpkv/npm",
        pullRequest: 433,
        goalId: "goal-433",
        laneId: "lane-433",
        operationId: "operation-433",
        expectedRevision: 2,
        expectedHead: "0123456789abcdef0123456789abcdef01234567",
        newHead: "abcdefabcdefabcdefabcdefabcdefabcdefabcd",
        expectedOwner: { id: "owner-1", name: "Owner" },
        expectedGoalEventId: "event-433",
        bindingDispatchRequestId: "dispatch-433",
        sessionId: "01a0ae7d-ed74-73c1-8454-4aed86de10cc",
        expectedWork: "feat/guided-review-rly",
        worker: { agentId: "agent-433", host: "SER8", name: "Owner", paneId: "w1:p3" },
        worktree: "/worktrees/npm/feat/guided-review-rly",
        branch: "feat/guided-review-rly"
      }
    }
    const html = renderToStaticMarkup(
      <DashboardView
        busyJobId={null}
        notificationState="disabled"
        onDecision={() => undefined}
        onDisableNotifications={undefined}
        onEnableNotifications={undefined}
        onRefresh={undefined}
        pull={{ distance: 0, ready: false, refreshing: false }}
        snapshot={{
          ...base,
          pendingApprovals: { ...base.pendingApprovals, local: [pending] },
          records: [pending]
        }}
      />
    )
    expect(html).toContain("Reconcile existing Work owner")
    expect(html).toContain("knpkv/npm#433: existing owner")
  })

  it("shows the goal reassignment title and summary", () => {
    const base = snapshot(true)
    const pending: DashboardSnapshot["records"][number] = {
      ...pendingRecord,
      payload: {
        kind: "work.reassign",
        goalId: "goal-ser8-control-surface",
        from: { id: "owner-host-coordinator", name: "Codex host coordinator" },
        to: { id: "agent-claude-coord", name: "Claude coordinator" },
        toAgent: {
          _tag: "set",
          agent: {
            host: "SER8",
            agentId: "agent-claude-coord",
            name: "coord",
            paneId: "w1J:p9",
            relationship: { parentAgentId: "agent-lead", relation: "delegated" }
          }
        },
        reason: "Codex identities retired",
        expectedGoalEventId: "goal-event-7",
        expectedGoalUpdatedAt: 500
      }
    }
    const html = renderToStaticMarkup(
      <DashboardView
        busyJobId={null}
        notificationState="disabled"
        onDecision={() => undefined}
        onDisableNotifications={undefined}
        onEnableNotifications={undefined}
        onRefresh={undefined}
        pull={{ distance: 0, ready: false, refreshing: false }}
        snapshot={{
          ...base,
          pendingApprovals: { ...base.pendingApprovals, local: [pending] },
          records: [pending]
        }}
      />
    )
    expect(html).toContain("Reassign Work goal owner")
    expect(html).toContain("goal-ser8-control-surface: Codex host coordinator → Claude coordinator")
  })

  it("hides decisions on a non-approval listener", () => {
    expect(render(false)).not.toContain("/v1/jobs/job-1/approve")
    expect(render(false)).not.toContain("/v1/jobs/job-1/reject")
  })

  it("renders decisions on an approval listener", () => {
    expect(render(true)).toContain("/v1/jobs/job-1/approve")
    expect(render(true)).toContain("/v1/jobs/job-1/reject")
  })

  it("hides decisions when a pending record has no approval proof", () => {
    const base = snapshot(true)
    const pending = { ...pendingRecord, approvalAvailable: false }
    const html = renderToStaticMarkup(
      <DashboardView
        busyJobId={null}
        notificationState="disabled"
        onDecision={() => undefined}
        onDisableNotifications={undefined}
        onRefresh={undefined}
        onEnableNotifications={undefined}
        pull={{ distance: 0, ready: false, refreshing: false }}
        snapshot={{
          ...base,
          pendingApprovals: { ...base.pendingApprovals, local: [pending] },
          records: [pending]
        }}
      />
    )
    expect(html).not.toContain("/v1/jobs/job-1/approve")
    expect(html).not.toContain("/v1/jobs/job-1/reject")
    expect(html).not.toContain("Approval keyboard shortcuts")
  })

  it("encodes schema-valid job identifiers in approval form actions", () => {
    const base = snapshot(true)
    const pending = { ...pendingRecord, id: "job/with-slash" }
    const html = renderToStaticMarkup(
      <DashboardView
        busyJobId={null}
        notificationState="disabled"
        onDecision={() => undefined}
        onDisableNotifications={undefined}
        onEnableNotifications={undefined}
        onRefresh={undefined}
        pull={{ distance: 0, ready: false, refreshing: false }}
        snapshot={{
          ...base,
          pendingApprovals: { ...base.pendingApprovals, local: [pending] },
          records: [pending]
        }}
      />
    )
    expect(html).toContain("/v1/jobs/job%2Fwith-slash/approve")
    expect(html).toContain("/v1/jobs/job%2Fwith-slash/reject")
  })

  it("names the configured canonical approval hub", () => {
    expect(render(false)).toContain("Open ser8.example.test")
    expect(render(false)).not.toContain("KNPKV-SER8")
  })

  it("routes worker Connect links through the canonical hub", () => {
    const base = snapshot(false)
    const active: DashboardSnapshot["records"][number] = {
      ...pendingRecord,
      approvalExpiresAt: null,
      approvalAvailable: false,
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
        notificationState="disabled"
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
        notificationState="disabled"
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
        notificationState="disabled"
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
    expect(markup).toContain("Recently decided")
    expect(markup).not.toContain("Agent activity")
    expect(markup).not.toContain("Activity history")
  })

  it("labels the human approval decision independently from later execution failure", () => {
    const markup = renderApprovedFailure()
    expect(markup).toContain("Approved")
    expect(markup).not.toContain(">Failed<")
  })

  it("lists this host's agents read-only, each with a stable id linked to its terminal on the hub", () => {
    const markup = renderMixedAgentStates()
    const panel = markup.slice(markup.indexOf('class="host-agent-list"'))
    expect(markup).toContain("Agents on ALPHA")
    expect(panel.slice(0, panel.indexOf("</ul>"))).not.toContain("<button")
    expect(markup).toContain('href="https://ser8.example.test/connect/?agent=agent-working&amp;host=ALPHA"')
    expect(markup).toContain('Open on the hub<span class="connect-visually-hidden">: worker</span>')
    expect(markup).not.toContain("agent-presence")
  })

  it("links only agents with a stable id", () => {
    const markup = renderMixedAgentStates({
      agents: [{ ...workingAgent, agentId: null }]
    })
    expect(markup).toContain(">worker<")
    expect(markup).not.toContain("Open on the hub")
  })

  it("names the cause and fix when there are no agents, or Herdr isn't running", () => {
    expect(renderMixedAgentStates({ agents: [] })).toContain("No agents running on ALPHA.")
    expect(renderMixedAgentStates({ agents: [], available: false, error: null })).toContain(
      "Herdr isn&#x27;t running on ALPHA."
    )
    expect(renderMixedAgentStates({ agents: [], available: false, error: "socket missing" })).toContain(
      "Herdr isn&#x27;t running on ALPHA: socket missing."
    )
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

describe("host dashboard page", () => {
  it("is server-rendered with the text-node separators hydration needs (React #418)", () => {
    const page = dashboardPage(snapshot(true), "")
    const root = page.slice(page.indexOf('<div id="fleet-dashboard-root">'), page.indexOf("</div>\n<script"))
    // renderToString marks where adjacent text nodes meet; static markup merges them and the
    // hydrating client then finds different text.
    expect(root).toContain("<!-- -->")
  })
})
