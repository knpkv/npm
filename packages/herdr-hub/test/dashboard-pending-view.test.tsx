// @vitest-environment happy-dom

import { describe, expect, it, vi } from "@effect/vitest"
import { act } from "react"
import { Exit } from "effect"
import { createRoot } from "react-dom/client"
import type { ApprovalDecision } from "../src/approval-decision.js"
import { ApprovalsCountdown } from "../src/countdown-view.js"
import type { DashboardSnapshot, FleetPendingApprovals } from "../src/dashboard-model.js"
import { useDashboardPendingTarget } from "../src/internal/use-dashboard-pending-target.js"
import {
  withPendingApprovalTarget,
  type PendingApprovalTargetRevalidation
} from "../src/internal/dashboard-pending-state.js"
import { loadDashboardPendingPage } from "../src/internal/dashboard-pending-state.js"
import { useDashboardPending } from "../src/internal/use-dashboard-pending.js"

Object.assign(window, { IS_REACT_ACT_ENVIRONMENT: true })

type JobRecord = DashboardSnapshot["records"][number]

const record = (id: string, overrides: Partial<JobRecord> = {}): JobRecord => ({
  actor: "submitter@example.com",
  approvalAvailable: true,
  approvalExpiresAt: Date.now() + 4 * 60_000,
  approvedAt: null,
  approvedBy: null,
  createdAt: Date.now() - 60_000,
  expiredAt: null,
  id,
  payload: { kind: "nix.apply", ref: "main" },
  rejectedAt: null,
  rejectedBy: null,
  status: "pending_approval",
  updatedAt: Date.now(),
  ...overrides
})

const snapshot = (overrides: Partial<DashboardSnapshot> = {}): DashboardSnapshot => ({
  approvalApp: {
    canonical: true,
    canonicalUrl: "https://hub.example.test/",
    pushEnabled: false,
    superapp: true,
    fleet: true,
    workEnabled: false
  },
  approvalsEnabled: true,
  directory: null,
  historyNextCursor: null,
  host: "ALPHA",
  // A hub whose clock agrees with the browser's; skew is tested on its own.
  observedAt: Date.now(),
  pendingApprovals: { failures: [], local: [record("job-1")], nextCursors: [], remote: [] },
  records: [],
  status: {
    applyConfigured: true,
    branch: "main",
    dirty: false,
    herdr: { agents: [], available: true, error: null },
    host: "ALPHA",
    repository: "/repo",
    revision: "abc"
  },
  work: null,
  ...overrides
})

// Uses the dashboard parent's pending-state hook with the real decision component.
describe("dashboard pending refresh composition", () => {
  it.each(["changed", "removed", "local-failed", "unchanged"])(
    "verifies a stale decision against the actual %s refresh",
    (kind) => {
      vi.useFakeTimers()
      const container = document.createElement("div")
      document.body.append(container)
      const root = createRoot(container)
      const decisions: Array<ApprovalDecision> = []
      let reads = 0
      const Bridge = ({ snapshot: received }: { readonly snapshot: DashboardSnapshot }) => {
        const { state: pending } = useDashboardPending(received)
        return (
          <ApprovalsCountdown
            decisionStatus={null}
            historyLoading={false}
            onDecision={(decision) => decisions.push(decision)}
            onLoadHistory={undefined}
            onLoadPending={undefined}
            onRevalidate={() => {
              reads += 1
            }}
            pendingLoading={false}
            sending={null}
            snapshot={{ ...received, pendingApprovals: pending }}
          />
        )
      }
      try {
        const initial = snapshot()
        act(() => root.render(<Bridge snapshot={initial} />))
        for (let second = 0; second < 31; second += 1) act(() => vi.advanceTimersByTime(1_000))
        act(() =>
          container
            .querySelector(".countdown")
            ?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ctrlKey: true, key: "Enter" }))
        )
        expect(reads).toBe(1)
        expect(decisions).toEqual([])
        const next: DashboardSnapshot = {
          ...initial,
          observedAt: Date.now(),
          pendingApprovals: {
            ...initial.pendingApprovals,
            failures: kind === "local-failed" ? [{ host: "ALPHA", reason: "request_failed" }] : [],
            local:
              kind === "removed"
                ? []
                : kind === "changed"
                  ? initial.pendingApprovals.local.map((job) => ({
                      ...job,
                      payload: { kind: "nix.apply", ref: "release" }
                    }))
                  : initial.pendingApprovals.local
          }
        }
        act(() => root.render(<Bridge snapshot={next} />))
        expect(decisions).toEqual(kind === "unchanged" ? [{ decision: "approve", jobId: "job-1" }] : [])
        act(() => root.render(<Bridge snapshot={{ ...next, observedAt: Date.now() + 1 }} />))
        expect(decisions).toEqual(kind === "unchanged" ? [{ decision: "approve", jobId: "job-1" }] : [])
      } finally {
        act(() => root.unmount())
        container.remove()
        vi.useRealTimers()
      }
    }
  )
})

/** Exercises the actual parent hook and continuation loader, including a response after refresh. */
describe("dashboard pending pagination", () => {
  it.each([false, true])("merges a current page but cancels one from an older read (refresh=%s)", async (refresh) => {
    const initial = snapshot({
      pendingApprovals: {
        failures: [],
        local: [record("job-1")],
        remote: [],
        nextCursors: [{ host: "ALPHA", cursor: { createdAt: 1, id: "cursor-1" } }]
      }
    })
    let finish = (_page: Exit.Exit<FleetPendingApprovals, never>): void => {
      expect.fail("loader was not started")
    }
    const page = new Promise<Exit.Exit<FleetPendingApprovals, never>>((resolve) => {
      finish = resolve
    })
    const container = document.createElement("div")
    document.body.append(container)
    const root = createRoot(container)
    const Parent = ({ snapshot: received }: { readonly snapshot: DashboardSnapshot }) => {
      const { state, update } = useDashboardPending(received)
      return (
        <div>
          <span>{state.local.map(({ id }) => id).join(",")}</span>
          <button
            onClick={() => {
              void loadDashboardPendingPage(state, () => page, update)
            }}
          >
            Load
          </button>
        </div>
      )
    }
    try {
      act(() => root.render(<Parent snapshot={initial} />))
      act(() => container.querySelector("button")?.click())
      if (refresh)
        act(() =>
          root.render(
            <Parent
              snapshot={{
                ...initial,
                observedAt: initial.observedAt + 1,
                pendingApprovals: { ...initial.pendingApprovals, local: [record("job-new")] }
              }}
            />
          )
        )
      await act(async () => {
        finish(Exit.succeed({ failures: [], local: [record("job-page")], nextCursors: [], remote: [] }))
        await page
      })
      expect(container.querySelector("span")?.textContent).toBe(refresh ? "job-new" : "job-1,job-page")
    } finally {
      act(() => root.unmount())
      container.remove()
    }
  })
})

/** A request looked up beyond page one cannot borrow freshness from the next first-page read. */
describe("deep-linked approval refresh", () => {
  it.each(["changed", "removed", "failed", "dashboard-failed", "unchanged"])(
    "waits for the target's %s lookup",
    async (kind) => {
      vi.useFakeTimers()
      const container = document.createElement("div")
      document.body.append(container)
      const root = createRoot(container)
      const decisions: Array<ApprovalDecision> = []
      const resolves: Array<(result: PendingApprovalTargetRevalidation) => void> = []
      const load = () =>
        new Promise<PendingApprovalTargetRevalidation>((resolve) => {
          resolves.push(resolve)
        })
      let reads = 0
      const Parent = ({
        failed = false,
        snapshot: received
      }: {
        readonly snapshot: DashboardSnapshot
        readonly failed?: boolean
      }) => {
        const { state: pending } = useDashboardPending(received)
        const { check, target } = useDashboardPendingTarget(received, { host: "ALPHA", jobId: "job-1" }, load)
        return (
          <ApprovalsCountdown
            decisionStatus={null}
            historyLoading={false}
            onDecision={(decision) => decisions.push(decision)}
            onLoadHistory={undefined}
            onLoadPending={undefined}
            onRevalidate={() => {
              reads += 1
            }}
            pendingLoading={false}
            pendingTargetCheck={check}
            refreshFailed={failed}
            sending={null}
            snapshot={withPendingApprovalTarget({ ...received, pendingApprovals: pending }, target)}
          />
        )
      }
      const settle = async (result: PendingApprovalTargetRevalidation) => {
        expect(resolves).toHaveLength(1)
        const resolve = resolves.shift()
        await act(async () => {
          resolve?.(result)
        })
      }
      const bar = () => container.querySelector<HTMLElement>("[data-rly-decision-bar]")
      try {
        const initial = snapshot({
          pendingApprovals: {
            failures: [],
            local: [],
            remote: [],
            nextCursors: [{ host: "ALPHA", cursor: { createdAt: 1, id: "cursor-1" } }]
          }
        })
        const original = record("job-1")
        act(() => root.render(<Parent snapshot={initial} />))
        await settle({ _tag: "Found", target: { _tag: "local", record: original } })
        for (let second = 0; second < 31; second += 1) act(() => vi.advanceTimersByTime(1_000))
        act(() =>
          container
            .querySelector(".countdown")
            ?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ctrlKey: true, key: "Enter" }))
        )
        expect(reads).toBe(1)
        expect(decisions).toEqual([])
        const next = { ...initial, observedAt: Date.now() }
        act(() => root.render(<Parent snapshot={next} />))
        expect(decisions).toEqual([])
        expect(bar()?.dataset["state"]).toBe("off")
        expect(bar()?.textContent).toContain("Checking this request before deciding.")
        if (kind === "dashboard-failed") act(() => root.render(<Parent snapshot={next} failed />))
        await settle(
          kind === "removed"
            ? { _tag: "Missing" }
            : kind === "failed"
              ? { _tag: "Retry" }
              : {
                  _tag: "Found",
                  target: {
                    _tag: "local",
                    record:
                      kind === "changed"
                        ? {
                            ...original,
                            payload: { kind: "nix.apply", ref: "release" }
                          }
                        : original
                  }
                }
        )
        expect(decisions).toEqual(kind === "unchanged" ? [{ decision: "approve", jobId: "job-1" }] : [])
        if (kind === "failed") {
          expect(bar()?.dataset["state"]).toBe("off")
          expect(bar()?.textContent).toContain("Couldn't check this request.")
          expect([...container.querySelectorAll("button")].some((button) => button.textContent === "Retry")).toBe(true)
        }
        if (kind === "removed") expect(bar()?.textContent).toContain("no longer waiting")
        act(() => root.render(<Parent snapshot={{ ...next, observedAt: Date.now() + 1 }} />))
        await settle({ _tag: "Found", target: { _tag: "local", record: original } })
        expect(decisions).toEqual(kind === "unchanged" ? [{ decision: "approve", jobId: "job-1" }] : [])
      } finally {
        act(() => root.unmount())
        container.remove()
        vi.useRealTimers()
      }
    }
  )
})
