import "../../src/assets.css"
import { Schema } from "effect"
import { useState } from "react"
import { createRoot } from "react-dom/client"
import type { ApprovalDecision } from "../../src/approval-decision.js"
import { DashboardView } from "../../src/dashboard-view.js"
import type { DashboardSnapshot } from "../../src/dashboard-model.js"
import { FleetShell } from "../../src/shell-view.js"

const FixtureState = Schema.Literals([
  "populated",
  "urgent-5m",
  "urgent-60s",
  "decision-bar",
  "remote-selected",
  "empty",
  "fresh-install",
  "host-unchecked",
  "paged",
  "paged-first-empty",
  "approvals-off",
  "notifications-strip",
  "refresh-failure",
  "long-text",
  "shortcuts-dialog",
  "full-request-open",
  "stale",
  "unknown-requester",
  "host-read-failed"
])
const params = new URLSearchParams(location.search)
const state = Schema.decodeUnknownSync(FixtureState)(params.get("state") ?? "populated")
const theme = Schema.decodeUnknownSync(Schema.Literals(["light", "dark"]))(params.get("theme") ?? "dark")
document.body.dataset["rlyTheme"] = theme

const observedAt = Date.now()
const start = observedAt + (state === "stale" ? 30_000 : 0)
type Record = DashboardSnapshot["records"][number]
const worker = { agentId: "agent-runner", host: "atlas", name: "run-bb", paneId: "w1:p1" }
const request: Record = {
  actor: state === "unknown-requester" ? " " : "owner",
  approvalAvailable: true,
  approvalExpiresAt: start + 14 * 60_000,
  approvedAt: null,
  approvedBy: null,
  createdAt: start - 2 * 60_000,
  expiredAt: null,
  id: "apr_451d2c",
  payload: {
    kind: "agent.delegate",
    mode: "review",
    repository: "/workspace/project",
    prompt: "[redacted internal prompt]"
  },
  rejectedAt: null,
  rejectedBy: null,
  status: "pending_approval",
  updatedAt: start,
  worker,
  connectTarget: { agentId: worker.agentId, host: worker.host, url: "/connect/?agent=agent-runner&host=atlas" }
}
const apply: Record = {
  ...request,
  id: "apr_4f2c1e",
  approvalExpiresAt:
    start + (state === "urgent-5m" ? 3 * 60_000 + 12_000 : state === "urgent-60s" ? 43_000 : 27 * 60_000),
  payload: { kind: "nix.apply", ref: "main@4f2c1e0" }
}
const admissionPayload = {
  kind: "work.admit",
  repository: "example/project",
  pullRequest: 451,
  reviewUrl: "https://github.com/example/project/pull/451",
  goalId: "WK-212",
  laneId: "review",
  operationId: "admit-1",
  expectedAbsenceToken: "a".repeat(64),
  head: "a".repeat(40),
  baseHead: "b".repeat(40),
  owner: { id: "owner-1", name: "build-bot" },
  sessionId: "11111111-1111-1111-1111-111111111111",
  expectedWork: "package checks",
  worker,
  worktree: "/workspace/project",
  branch: "main",
  title:
    "Admit the nightly dependency refresh for every workspace package into the shared review queue before the Friday freeze",
  summary: "Review the dependency refresh",
  detail: "Record the existing owner and revision before admission."
} satisfies Record["payload"]
const admission: Record = {
  ...request,
  id: "apr_garden-orange-builder_20261010T140211Z_7c1d",
  approvalExpiresAt: start + 22 * 60_000,
  payload: admissionPayload
}
const remotePayload = {
  kind: "work.reassign",
  goalId: "WK-212",
  from: { id: "old", name: "rev-audit" },
  to: { id: "new", name: "pair-agent" },
  toAgent: { _tag: "clear" },
  reason: "Transfer review ownership",
  expectedGoalEventId: "event-1",
  expectedGoalUpdatedAt: start
} satisfies Record["payload"]
const reassignRemote = {
  approval: {
    actor: "owner",
    approvalExpiresAt: start + 41 * 60_000,
    createdAt: start - 2 * 60_000,
    id: "apr_reassign",
    status: "pending_approval",
    payload: remotePayload
  },
  approvalUrl: "https://birch.example.test/",
  host: "birch"
} satisfies DashboardSnapshot["pendingApprovals"]["remote"][number]
const empty = ["empty", "fresh-install", "host-unchecked", "paged-first-empty"].includes(state)
const failed = state === "host-read-failed"
const paged = state === "paged" || state === "paged-first-empty"
const base: DashboardSnapshot = {
  approvalApp: {
    canonical: true,
    canonicalUrl: "https://hub.example.test/",
    pushEnabled: true,
    superapp: true,
    fleet: true,
    workEnabled: false,
    sandboxesEnabled: false
  },
  approvalsEnabled: state !== "approvals-off",
  directory: null,
  historyNextCursor: paged ? { createdAt: start - 2 * 60 * 60_000, id: "decided-admission" } : null,
  host: "atlas",
  observedAt,
  pendingApprovals: {
    failures:
      state === "host-unchecked"
        ? [{ host: "cedar", reason: "offline" }]
        : failed
          ? [
              { host: "atlas", reason: "request_failed" },
              { host: "cedar", reason: "offline" }
            ]
          : [],
    local: empty ? [] : state === "long-text" ? [request] : [request, apply],
    nextCursors: paged ? [{ host: "atlas", cursor: { createdAt: start, id: "request-4" } }] : [],
    remote:
      empty || failed
        ? []
        : [
            {
              approval: {
                actor: "owner",
                approvalExpiresAt: start + (state === "long-text" ? 22 : 41) * 60_000,
                createdAt: start - 2 * 60_000,
                id: state === "long-text" ? admission.id : "apr_reassign",
                status: "pending_approval",
                payload: state === "long-text" ? admission.payload : remotePayload
              },
              approvalUrl: "https://birch.example.test/",
              host: state === "long-text" ? "garden-orange-builder" : "birch"
            },
            ...(state === "long-text" ? [reassignRemote] : [])
          ]
  },
  records:
    state === "fresh-install"
      ? []
      : [
          {
            ...request,
            id: "decided-check",
            payload: { kind: "nix.check" },
            approvedAt: start - 4 * 60_000,
            approvedBy: "owner",
            status: "succeeded",
            approvalAvailable: false
          },
          {
            ...request,
            id: "decided-message",
            payload: { kind: "agent.message", session: "pair-agent", message: "[redacted internal prompt]" },
            rejectedAt: start - 60 * 60_000,
            rejectedBy: "owner",
            status: "rejected",
            approvalAvailable: false
          },
          {
            ...admission,
            id: "decided-admission",
            payload: { ...admissionPayload, title: "Admit nightly dependency refresh" },
            expiredAt: start - 2 * 60 * 60_000,
            status: "expired",
            approvalAvailable: false
          }
        ],
  status: {
    applyConfigured: true,
    host: "atlas",
    repository: { branch: "main", dirty: false, path: "/workspace/project", revision: "4f2c1e0" },
    herdr: {
      available: true,
      error: null,
      agents: [
        {
          agentId: "agent-owner",
          activityRevision: 1,
          kind: "codex",
          name: "owner",
          paneId: "w1:p2",
          parentAgentId: null,
          relation: null,
          status: "working",
          work: "review"
        }
      ]
    }
  },
  work: null
}

/** Render the production shell and real notification/shortcut components with fixed request data. */
const Fixture = () => {
  const [snapshot, setSnapshot] = useState(base)
  const [refreshFailed, setRefreshFailed] = useState(state === "refresh-failure")
  const [decisions, setDecisions] = useState<ReadonlyArray<ApprovalDecision>>([])
  const [reads, setReads] = useState(0)
  return (
    <>
      <FleetShell
        hostCount={3}
        connect={null}
        work={null}
        usage={null}
        approvals={
          <DashboardView
            approvalOnly
            busyJobId={null}
            showHeader={false}
            historyLoading={false}
            pendingLoading={false}
            notificationState={state === "notifications-strip" ? "disabled" : "enabled"}
            onDisableNotifications={() => {}}
            onEnableNotifications={() => {}}
            onDecision={(decision) => setDecisions((current) => [...current, decision])}
            onLoadHistory={() => setReads((count) => count + 1)}
            onLoadPending={() => setReads((count) => count + 1)}
            onRefresh={() => {
              setReads((count) => count + 1)
              setRefreshFailed(false)
              setSnapshot((current) => ({
                ...current,
                observedAt: Date.now(),
                pendingApprovals: { ...current.pendingApprovals, failures: [] }
              }))
            }}
            pull={{ distance: 0, ready: false, refreshing: false }}
            refreshFailed={refreshFailed}
            snapshot={snapshot}
          />
        }
      />
      <output hidden data-fixture-decisions>
        {JSON.stringify(decisions)}
      </output>
      <output hidden data-fixture-reads>
        {String(reads)}
      </output>
    </>
  )
}
const root = document.querySelector("#root")
if (root !== null) createRoot(root).render(<Fixture />)
