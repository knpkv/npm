// @vitest-environment happy-dom

import { describe, expect, it } from "@effect/vitest"
import { act } from "react"
import { createRoot } from "react-dom/client"
import type { ApprovalDecision } from "../src/approval-decision.js"
import { ApprovalsCountdown, type DecisionStatus } from "../src/countdown-view.js"
import type { DashboardSnapshot } from "../src/dashboard-model.js"

Object.assign(window, { IS_REACT_ACT_ENVIRONMENT: true })

type JobRecord = DashboardSnapshot["records"][number]

const record = (id: string, overrides: Partial<JobRecord> = {}): JobRecord => ({
  actor: "submitter@example.com",
  approvalAvailable: true,
  approvalExpiresAt: Date.now() + 4 * 60_000,
  approvalNonce: "nonce",
  approvedAt: null,
  approvedBy: null,
  createdAt: Date.now() - 60_000,
  error: null,
  expiredAt: null,
  hash: "hash",
  id,
  payload: { kind: "nix.apply", ref: "main" },
  rejectedAt: null,
  rejectedBy: null,
  result: null,
  status: "pending_approval",
  updatedAt: Date.now(),
  ...overrides
})

const snapshot = (overrides: Partial<DashboardSnapshot> = {}): DashboardSnapshot => ({
  approvalApp: { canonical: true, canonicalUrl: "https://hub.example.test/", chatEnabled: false, pushEnabled: false },
  approvalsEnabled: true,
  chat: null,
  directory: null,
  historyNextCursor: null,
  host: "ALPHA",
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

interface Props {
  readonly decisionStatus?: DecisionStatus | null
  readonly sending?: ApprovalDecision | null
  readonly snapshot: DashboardSnapshot
}

const mount = (initial: Props) => {
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  const decisions: Array<ApprovalDecision> = []
  const render = (props: Props) =>
    act(() =>
      root.render(
        <ApprovalsCountdown
          decisionStatus={props.decisionStatus ?? null}
          historyLoading={false}
          onDecision={(decision) => decisions.push(decision)}
          onLoadHistory={undefined}
          onLoadPending={undefined}
          pendingLoading={false}
          sending={props.sending ?? null}
          snapshot={props.snapshot}
        />
      )
    )
  render(initial)
  const bar = () => container.querySelector<HTMLElement>("[data-rly-decision-bar]")
  const press = (key: string, shift = false) =>
    act(() => {
      container
        .querySelector(".countdown")
        ?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ctrlKey: true, key, shiftKey: shift }))
    })
  const unmount = () => {
    act(() => root.unmount())
    container.remove()
  }
  return { bar, container, decisions, press, render, unmount }
}

describe("ApprovalsCountdown", () => {
  it("leads with the soonest request and mounts a single decision bar", () => {
    const view = mount({
      snapshot: snapshot({
        pendingApprovals: {
          failures: [],
          local: [
            record("later", { approvalExpiresAt: Date.now() + 20 * 60_000 }),
            record("sooner", { approvalExpiresAt: Date.now() + 2 * 60_000 })
          ],
          nextCursors: [],
          remote: []
        }
      })
    })
    expect(view.container.querySelector("[aria-label='Approval summary'] p")?.textContent).toMatch(
      /^\dm \d\ds left on Apply Nix configuration, expires soon$/
    )
    expect(view.container.querySelectorAll("[data-rly-decision-bar]")).toHaveLength(1)
    expect(view.container.querySelector("[aria-label='What the track marks mean']")?.textContent).toBe("5 minutes left")
    expect(view.container.querySelector(".countdown-kicker")?.textContent).toContain("sooner")
    view.unmount()
  })

  it("says unchecked hosts in the fact itself when nothing reachable is pending", () => {
    const view = mount({
      snapshot: snapshot({
        pendingApprovals: { failures: [{ host: "BETA", reason: "offline" }], local: [], nextCursors: [], remote: [] }
      })
    })
    const hero = view.container.querySelector("[aria-label='Approval summary']")
    expect(hero?.querySelector("p")?.textContent).toBe("Nothing to approve on reachable hosts; 1 host unchecked")
    view.unmount()
  })

  it("decides by shortcut only when the bar could", () => {
    const off = mount({ snapshot: snapshot({ approvalsEnabled: false }) })
    off.press("Enter")
    expect(off.decisions).toEqual([])
    expect(off.bar()?.dataset["state"]).toBe("off")
    off.unmount()

    const ready = mount({ snapshot: snapshot() })
    ready.press("Backspace", true)
    expect(ready.decisions).toEqual([{ decision: "reject", jobId: "job-1" }])
    ready.unmount()
  })

  it("keeps a remote request off with its owning host's link", () => {
    const view = mount({
      snapshot: snapshot({
        pendingApprovals: {
          failures: [],
          local: [],
          nextCursors: [],
          remote: [
            {
              approval: {
                actor: "ops@example.com",
                approvalExpiresAt: Date.now() + 3 * 60_000,
                createdAt: Date.now(),
                id: "remote-1",
                payload: { kind: "nix.check", ref: "main" },
                status: "pending_approval"
              },
              approvalUrl: "https://beta.example.test/approve/remote-1",
              host: "BETA"
            }
          ]
        }
      })
    })
    expect(view.bar()?.dataset["state"]).toBe("off")
    expect(view.bar()?.textContent).toContain("Decided on BETA.")
    expect(view.container.querySelector("a[href='https://beta.example.test/approve/remote-1']")?.textContent).toBe(
      "Review on BETA"
    )
    view.press("Enter")
    expect(view.decisions).toEqual([])
    view.unmount()
  })

  it("waits for the hub while sending, then shows its answer", () => {
    const view = mount({ sending: { decision: "approve", jobId: "job-1" }, snapshot: snapshot() })
    expect(view.bar()?.dataset["state"]).toBe("sending")
    view.press("Enter")
    expect(view.decisions).toEqual([])
    view.render({
      decisionStatus: { jobId: "job-1", observedAt: Date.now(), settles: true, text: "The hub refused: this request already changed." },
      snapshot: snapshot()
    })
    expect(view.bar()?.querySelector("[role='status']")?.textContent).toBe(
      "The hub refused: this request already changed."
    )
    view.unmount()
  })

  it("keeps the bar mounted and announces an expiry the hub reports", () => {
    const view = mount({ snapshot: snapshot() })
    act(() => view.container.querySelector<HTMLButtonElement>("[data-countdown-row]")?.click())
    view.render({
      snapshot: snapshot({
        pendingApprovals: { failures: [], local: [], nextCursors: [], remote: [] },
        records: [record("job-1", { expiredAt: Date.now(), status: "expired" })]
      })
    })
    expect(view.bar()?.dataset["state"]).toBe("off")
    expect(view.bar()?.querySelector("[role='status']")?.textContent).toBe("Expired just now. Nothing was applied.")
    view.unmount()
  })

  it("decides the focused row's request by shortcut, not the first one", () => {
    const view = mount({
      snapshot: snapshot({
        pendingApprovals: {
          failures: [],
          local: [
            record("first", { approvalExpiresAt: Date.now() + 2 * 60_000 }),
            record("second", { approvalExpiresAt: Date.now() + 8 * 60_000 })
          ],
          nextCursors: [],
          remote: []
        }
      })
    })
    const second = view.container.querySelectorAll<HTMLButtonElement>("[data-countdown-row]")[1]
    act(() => {
      second?.focus()
      second?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ctrlKey: true, key: "Enter" }))
    })
    expect(view.decisions).toEqual([{ decision: "approve", jobId: "second" }])
    expect(view.container.querySelector(".countdown-kicker")?.textContent).toContain("second")
    view.unmount()
  })

  it("keeps the decided request and the hub's answer after it leaves the queue", () => {
    const view = mount({
      snapshot: snapshot({
        pendingApprovals: {
          failures: [],
          local: [record("job-1"), record("job-2", { approvalExpiresAt: Date.now() + 9 * 60_000 })],
          nextCursors: [],
          remote: []
        }
      })
    })
    act(() => view.bar()?.querySelector<HTMLButtonElement>("button")?.click())
    expect(view.decisions).toEqual([{ decision: "approve", jobId: "job-1" }])
    view.render({
      decisionStatus: { jobId: "job-1", observedAt: Date.now(), settles: true, text: "The hub recorded your approval; the job is queued." },
      snapshot: snapshot({
        pendingApprovals: {
          failures: [],
          local: [record("job-2", { approvalExpiresAt: Date.now() + 9 * 60_000 })],
          nextCursors: [],
          remote: []
        },
        records: [record("job-1", { approvedAt: Date.now(), approvedBy: "owner@example.com", status: "queued" })]
      })
    })
    expect(view.container.querySelector(".countdown-kicker")?.textContent).toContain("job-1")
    expect(view.bar()?.dataset["state"]).toBe("off")
    expect(view.bar()?.querySelector("[role='status']")?.textContent).toBe(
      "The hub recorded your approval; the job is queued."
    )
    view.press("Enter")
    expect(view.decisions).toHaveLength(1)
    view.unmount()
  })

  it("keeps the first request pinned when the queue moves under it", () => {
    const view = mount({
      snapshot: snapshot({
        pendingApprovals: {
          failures: [],
          local: [record("job-1"), record("job-2", { approvalExpiresAt: Date.now() + 9 * 60_000 })],
          nextCursors: [],
          remote: []
        }
      })
    })
    view.render({
      snapshot: snapshot({
        pendingApprovals: {
          failures: [],
          local: [record("job-2", { approvalExpiresAt: Date.now() + 9 * 60_000 })],
          nextCursors: [],
          remote: []
        },
        records: [record("job-1", { expiredAt: Date.now(), status: "expired" })]
      })
    })
    expect(view.container.querySelector(".countdown-kicker")?.textContent).toContain("job-1")
    expect(view.bar()?.dataset["state"]).toBe("off")
    expect(view.bar()?.querySelector("[role='status']")?.textContent).toBe("Expired just now. Nothing was applied.")
    view.press("Enter")
    expect(view.decisions).toEqual([])
    view.unmount()
  })

  it("does not call a request gone when it may just be on an unloaded page", () => {
    const view = mount({
      snapshot: snapshot({
        pendingApprovals: {
          failures: [],
          local: [record("job-1"), record("job-2", { approvalExpiresAt: Date.now() + 9 * 60_000 })],
          nextCursors: [],
          remote: []
        }
      })
    })
    act(() => view.container.querySelectorAll<HTMLButtonElement>("[data-countdown-row]")[1]?.click())
    view.render({
      snapshot: snapshot({
        pendingApprovals: {
          failures: [],
          local: [record("job-1")],
          nextCursors: [{ cursor: { createdAt: 1, id: "job-1" }, host: "ALPHA" }],
          remote: []
        }
      })
    })
    expect(view.container.querySelector(".countdown-kicker")?.textContent).toContain("job-2")
    expect(view.bar()?.dataset["state"]).toBe("ready")
    view.unmount()
  })

  it("says a remote request left its own host's queue, never a local job's outcome", () => {
    const remote: DashboardSnapshot["pendingApprovals"]["remote"][number] = {
      approval: {
        actor: "ops@example.com",
        approvalExpiresAt: Date.now() + 3 * 60_000,
        createdAt: Date.now(),
        id: "job-1",
        payload: { kind: "nix.check", ref: "main" },
        status: "pending_approval"
      },
      approvalUrl: "https://beta.example.test/approve/job-1",
      host: "BETA"
    }
    const view = mount({
      snapshot: snapshot({ pendingApprovals: { failures: [], local: [], nextCursors: [], remote: [remote] } })
    })
    view.render({
      snapshot: snapshot({
        pendingApprovals: { failures: [], local: [], nextCursors: [], remote: [] },
        records: [record("job-1", { approvedAt: Date.now(), approvedBy: "owner@example.com", status: "queued" })]
      })
    })
    expect(view.bar()?.querySelector("[role='status']")?.textContent).toBe("This request left BETA's queue.")
    view.unmount()
  })

  it("keeps a request off once the hub refused it", () => {
    const view = mount({
      decisionStatus: { jobId: "job-1", observedAt: Date.now(), settles: true, text: "The hub refused: this request already changed." },
      snapshot: snapshot()
    })
    expect(view.bar()?.dataset["state"]).toBe("off")
    view.press("Enter")
    expect(view.decisions).toEqual([])
    view.unmount()
  })

  it("carries the deep-link target on rows and selects a row on focus", () => {
    const view = mount({
      snapshot: snapshot({
        pendingApprovals: {
          failures: [],
          local: [record("job-1"), record("job-2", { approvalExpiresAt: Date.now() + 9 * 60_000 })],
          nextCursors: [],
          remote: []
        }
      })
    })
    const second = view.container.querySelector<HTMLButtonElement>(
      "[data-approval-host='ALPHA'][data-approval-job='job-2']"
    )
    expect(second?.hasAttribute("data-agenda-item")).toBe(true)
    act(() => second?.focus())
    expect(view.container.querySelector(".countdown-kicker")?.textContent).toContain("job-2")
    view.unmount()
  })

  it("announces a request the hub expired while another was selected", () => {
    const view = mount({
      snapshot: snapshot({
        pendingApprovals: {
          failures: [],
          local: [record("job-1"), record("job-2", { approvalExpiresAt: Date.now() + 9 * 60_000 })],
          nextCursors: [],
          remote: []
        }
      })
    })
    view.render({
      snapshot: snapshot({
        pendingApprovals: { failures: [], local: [record("job-1")], nextCursors: [], remote: [] },
        records: [record("job-2", { expiredAt: Date.now(), status: "expired" })]
      })
    })
    expect(view.container.querySelector(".countdown-announcer")?.textContent).toBe(
      "Apply Nix configuration (job-2) on ALPHA expired. Nothing was applied."
    )
    view.unmount()
  })

  it("lets a refused request be retried once a newer read still lists it as decidable", () => {
    const answeredAt = Date.now() - 1_000
    const status = { jobId: "job-1", observedAt: answeredAt, settles: true, text: "The hub refused." }
    const view = mount({ decisionStatus: status, snapshot: snapshot({ observedAt: answeredAt }) })
    expect(view.bar()?.dataset["state"]).toBe("off")
    view.render({ decisionStatus: status, snapshot: snapshot({ observedAt: answeredAt + 5_000 }) })
    expect(view.bar()?.dataset["state"]).toBe("ready")
    view.unmount()
  })

  it("does not call a remote request gone while its host has more pages", () => {
    const remote: DashboardSnapshot["pendingApprovals"]["remote"][number] = {
      approval: {
        actor: "ops@example.com",
        approvalExpiresAt: Date.now() + 3 * 60_000,
        createdAt: Date.now(),
        id: "job-9",
        payload: { kind: "nix.check", ref: "main" },
        status: "pending_approval"
      },
      approvalUrl: "https://beta.example.test/approve/job-9",
      host: "BETA"
    }
    const view = mount({
      snapshot: snapshot({ pendingApprovals: { failures: [], local: [], nextCursors: [], remote: [remote] } })
    })
    view.render({
      snapshot: snapshot({
        pendingApprovals: {
          failures: [],
          local: [],
          nextCursors: [{ cursor: { createdAt: 1, id: "job-1" }, host: "beta" }],
          remote: []
        }
      })
    })
    expect(view.bar()?.querySelector("[role='status']")?.textContent).toBe("")
    expect(view.container.querySelector(".countdown-kicker")?.textContent).toContain("job-9")
    view.unmount()
  })
})
