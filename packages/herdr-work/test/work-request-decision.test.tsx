// @vitest-environment happy-dom

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it } from "vitest"
import type { WorkGoal, WorkRequest, WorkSnapshots } from "../src/model.js"
import {
  type WorkRequestAnswer,
  type WorkRequestDecision,
  type WorkRequestDecisions,
  workRequestClockText
} from "../src/request-decision.js"
import { WorkBoard } from "../src/view.js"

declare global {
  interface Window {
    IS_REACT_ACT_ENVIRONMENT: boolean
  }
}

window.IS_REACT_ACT_ENVIRONMENT = true

const NOW = 1_000_000

const roots: Array<Root> = []

afterEach(async () => {
  await act(async () => {
    for (const root of roots) root.unmount()
  })
  roots.length = 0
  document.body.replaceChildren()
})

const request = (id: string, jobId: string, state: WorkRequest["state"] = "open"): WorkRequest => ({
  approvalTarget: { host: "HUB", jobId, url: `https://hub.example.test/?approvalJob=${jobId}` },
  id,
  requestedAt: NOW - 60_000,
  state,
  summary: `Apply ${id}`
})

const goal = (requests: ReadonlyArray<WorkRequest>): WorkGoal => ({
  blocker: null,
  connectTarget: null,
  createdAt: NOW - 120_000,
  delivery: "local",
  detail: "Ship the fleet change",
  id: "goal-1",
  owner: { id: "owner-1", name: "ui2-b" },
  repository: { branch: "feat/w2", repository: "npm" },
  requests,
  spend: null,
  state: "working",
  summary: "Ship the fleet change",
  title: "Fleet change",
  updatedAt: NOW - 60_000
})

const snapshotsOf = (requests: ReadonlyArray<WorkRequest>): WorkSnapshots => {
  const snapshot = (window: "now" | "day" | "week" | "month") => ({
    asOf: NOW,
    goals: [goal(requests)],
    observedAt: NOW,
    window
  })
  return {
    day: snapshot("day"),
    month: snapshot("month"),
    now: snapshot("now"),
    observedAt: NOW,
    week: snapshot("week")
  }
}

/** The decisions a test hands the board, and every decision the board sent. */
interface DecisionsFixture {
  readonly decisions: WorkRequestDecisions
  readonly sent: Array<WorkRequestDecision>
}

const decisionsOf = (
  pending: Readonly<Record<string, number | null>>,
  overrides: Partial<WorkRequestDecisions> = {}
): DecisionsFixture => {
  const sent: Array<WorkRequestDecision> = []
  return {
    decisions: {
      answer: null,
      expiresAt: (jobId) => (Object.hasOwn(pending, jobId) ? pending[jobId] : undefined),
      now: NOW,
      onDecision: (decision) => sent.push(decision),
      sending: null,
      ...overrides
    },
    sent
  }
}

const mount = async (props: Parameters<typeof WorkBoard>[0]): Promise<HTMLElement> => {
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  roots.push(root)
  await act(async () => root.render(<WorkBoard initialGoalId="goal-1" {...props} />))
  return host
}

const button = (host: HTMLElement, name: string): HTMLButtonElement | undefined =>
  [...host.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.getAttribute("aria-label") === name
  )

/** The decision bar's off reason and status text, as the reader sees them. */
const reasonAndStatus = (host: HTMLElement) => ({
  reason: host.querySelector("[id^='rly-decision-bar-reason-']")?.textContent ?? "",
  status: host.querySelector("[id^='rly-decision-bar-status-']")?.textContent ?? ""
})

describe("workRequestClockText", () => {
  it("keeps seconds under five minutes and reads expiring at zero, never negative", () => {
    expect(workRequestClockText(NOW + 52_000, NOW)).toBe("52s")
    expect(workRequestClockText(NOW + 4 * 60_000 + 12_000, NOW)).toBe("4m 12s")
    expect(workRequestClockText(NOW + 11 * 60_000 + 30_000, NOW)).toBe("11m")
    expect(workRequestClockText(NOW, NOW)).toBe("expiring")
    expect(workRequestClockText(NOW - 5_000, NOW)).toBe("expiring")
  })
})

describe("Work requests decided in place", () => {
  it("keeps the hub link when the host gives no decisions", async () => {
    const host = await mount({ snapshots: snapshotsOf([request("r1", "job-1")]) })
    expect(host.querySelector("a[href='https://hub.example.test/?approvalJob=job-1']")).not.toBeNull()
    expect(button(host, "Approve: Apply r1")).toBeUndefined()
  })

  it("decides a request the hub lists as pending, with its clock, and sends only that job", async () => {
    const { decisions, sent } = decisionsOf({ "job-1": NOW + 4 * 60_000 + 12_000 })
    const host = await mount({ decisions, snapshots: snapshotsOf([request("r1", "job-1")]) })
    expect(host.querySelector(".work-row-caption")?.textContent).toContain("Apply r1, 4m 12s left")
    expect(host.querySelector("[aria-label='Goal details'], .work-detail")?.textContent).toContain("4m 12s left")
    const approve = button(host, "Approve: Apply r1")
    expect(approve?.getAttribute("aria-disabled")).toBeNull()
    await act(async () => approve?.click())
    expect(sent).toEqual([{ decision: "approve", jobId: "job-1" }])
  })

  it("keeps the link for a request whose job this host does not list", async () => {
    const { decisions } = decisionsOf({ "job-other": NOW + 60_000 })
    const host = await mount({ decisions, snapshots: snapshotsOf([request("r1", "job-1")]) })
    expect(button(host, "Approve: Apply r1")).toBeUndefined()
    expect(host.querySelector("a[href='https://hub.example.test/?approvalJob=job-1']")).not.toBeNull()
  })

  it("keeps a pending job inert in a week checkpoint, then permits it back in Now", async () => {
    const { decisions, sent } = decisionsOf({ "job-1": NOW + 60_000 })
    const host = await mount({ decisions, initialWindow: "week", snapshots: snapshotsOf([request("r1", "job-1")]) })
    const approve = button(host, "Approve: Apply r1")
    const reject = button(host, "Reject: Apply r1")
    expect(approve).toBeDefined()
    expect(reject).toBeDefined()
    await act(async () => {
      approve?.click()
      reject?.click()
    })
    expect(sent).toEqual([])
    expect(approve?.getAttribute("aria-disabled")).toBe("true")
    expect(reject?.getAttribute("aria-disabled")).toBe("true")
    expect(reasonAndStatus(host).reason).toBe("Decisions are off in the past.")
    expect(host.querySelector(".work-row-caption")?.textContent).not.toContain("left")

    const back = [...host.querySelectorAll("button")].find((candidate) => candidate.textContent === "Back to now")
    await act(async () => back?.click())
    // Returning to Now closes details; reopen the same goal before deciding its current request.
    await act(async () => host.querySelector<HTMLButtonElement>(".work-board-row")?.click())
    const currentApprove = button(host, "Approve: Apply r1")
    expect(currentApprove?.getAttribute("aria-disabled")).toBeNull()
    await act(async () => currentApprove?.click())
    expect(sent).toEqual([{ decision: "approve", jobId: "job-1" }])
  })

  it("holds every other bar off while one decision waits for the hub", async () => {
    const { decisions, sent } = decisionsOf(
      { "job-1": NOW + 60_000, "job-2": NOW + 60_000 },
      { sending: { decision: "approve", jobId: "job-1" } }
    )
    const host = await mount({ decisions, snapshots: snapshotsOf([request("r1", "job-1"), request("r2", "job-2")]) })
    expect(host.querySelector("[aria-busy='true']")).not.toBeNull()
    const other = button(host, "Approve: Apply r2")
    expect(other?.getAttribute("aria-disabled")).toBe("true")
    await act(async () => other?.click())
    expect(sent).toEqual([])
  })

  it("drops the bar once the outcome is proven: the title and state word say it, and it is announced", async () => {
    const { decisions } = decisionsOf(
      {},
      { answer: { jobId: "job-1", outcome: "accepted", text: "The hub recorded your approval." } }
    )
    const host = await mount({ decisions, snapshots: snapshotsOf([request("r1", "job-1", "approved")]) })
    expect(button(host, "Approve: Apply r1")).toBeUndefined()
    expect(host.querySelector(".work-request-heading")?.textContent).toContain("ApprovedApply r1")
    expect(host.querySelector(".work-request-announcement")?.textContent).toBe("Apply r1: Approved.")
    expect(host.textContent).not.toContain("The hub recorded your approval.")
  })

  it("keeps a refusal's explanation under a proven outcome", async () => {
    const refusal = "The hub refused: another approver decided first."
    const { decisions } = decisionsOf({}, { answer: { jobId: "job-1", outcome: "refused", text: refusal } })
    const host = await mount({ decisions, snapshots: snapshotsOf([request("r1", "job-1", "approved")]) })
    expect(button(host, "Approve: Apply r1")).toBeUndefined()
    expect(host.textContent).toContain(refusal)
  })

  it("announces the outcome from the same status region the bar was mounted beside", async () => {
    const { decisions } = decisionsOf(
      { "job-1": NOW + 60_000 },
      { answer: { jobId: "job-1", outcome: "accepted", text: "The hub recorded your approval." } }
    )
    const hostElement = document.createElement("div")
    document.body.append(hostElement)
    const root = createRoot(hostElement)
    roots.push(root)
    const render = (state: WorkRequest["state"]) =>
      act(async () =>
        root.render(
          <WorkBoard
            decisions={decisions}
            initialGoalId="goal-1"
            snapshots={snapshotsOf([request("r1", "job-1", state)])}
          />
        )
      )
    await render("open")
    const region = hostElement.querySelector(".work-request-announcement")
    expect(region?.textContent).toBe("")
    await render("approved")
    expect(hostElement.querySelector(".work-request-announcement")).toBe(region)
    expect(region?.textContent).toBe("Apply r1: Approved.")
  })

  it("names the request once while its bar is shown", async () => {
    const { decisions } = decisionsOf({ "job-1": NOW + 60_000 })
    const host = await mount({ decisions, snapshots: snapshotsOf([request("r1", "job-1")]) })
    const item = host.querySelector(".work-detail-list li")
    expect(item?.querySelector(".work-request-heading")).toBeNull()
    expect(item?.textContent?.split("Apply r1").length).toBe(2)
  })

  it("lets the snapshot's proven outcome replace an uncertain answer", async () => {
    const uncertain = "Couldn't reach the hub, so the decision may not have arrived."
    const { decisions } = decisionsOf({}, { answer: { jobId: "job-1", outcome: "uncertain", text: uncertain } })
    const host = await mount({ decisions, snapshots: snapshotsOf([request("r1", "job-1", "approved")]) })
    expect(host.textContent).not.toContain(uncertain)
    // The proven outcome is said once, in the announcement; the state word shows it.
    expect(host.textContent?.split("Approved.").length).toBe(2)
    expect(host.textContent).not.toContain("no longer lists")
  })

  it("keeps an accepted decision off while the host still lists the job as pending", async () => {
    const { decisions, sent } = decisionsOf(
      { "job-1": NOW + 60_000 },
      { answer: { jobId: "job-1", outcome: "accepted", text: "The hub recorded your approval." } }
    )
    const host = await mount({ decisions, snapshots: snapshotsOf([request("r1", "job-1")]) })
    const reject = button(host, "Reject: Apply r1")
    expect(reject?.getAttribute("aria-disabled")).toBe("true")
    await act(async () => reject?.click())
    expect(sent).toEqual([])
    expect(host.textContent).toContain("Waiting for the hub's queue to update.")
  })

  it("lets a refused decision be tried again while the job is still pending", async () => {
    const { decisions } = decisionsOf(
      { "job-1": NOW + 60_000 },
      { answer: { jobId: "job-1", outcome: "refused", text: "The hub refused: approver not allowed." } }
    )
    const host = await mount({ decisions, snapshots: snapshotsOf([request("r1", "job-1")]) })
    expect(button(host, "Approve: Apply r1")?.getAttribute("aria-disabled")).toBeNull()
  })

  it("keeps an uncertain answer as it is while the request is still waiting", async () => {
    const uncertain = "Couldn't reach the hub, so the decision may not have arrived."
    const { decisions } = decisionsOf(
      { "job-1": NOW + 60_000 },
      { answer: { jobId: "job-1", outcome: "uncertain", text: uncertain } }
    )
    const host = await mount({ decisions, snapshots: snapshotsOf([request("r1", "job-1")]) })
    const status = [...host.querySelectorAll("[role='status']")].map(({ textContent }) => textContent)
    expect(status).toContain(uncertain)
  })

  it("never says the same thing twice in the off reason and the status while the bar is shown", async () => {
    const outcomes: ReadonlyArray<WorkRequestAnswer["outcome"]> = ["accepted", "refused", "uncertain"]
    // A bar is shown only while the request is open: pending here, or left the queue unproven.
    for (const outcome of outcomes) {
      for (const pending of [true, false]) {
        const text = outcome === "uncertain" ? "Couldn't reach the hub." : `The hub ${outcome} your decision.`
        const { decisions } = decisionsOf(pending ? { "job-1": NOW + 60_000 } : {}, {
          answer: { jobId: "job-1", outcome, text }
        })
        const host = await mount({ decisions, snapshots: snapshotsOf([request("r1", "job-1")]) })
        const { reason, status } = reasonAndStatus(host)
        const label = `${outcome}, ${pending ? "pending" : "not pending"}`
        if (reason !== "" && status !== "") {
          expect(status.includes(reason) || reason.includes(status), label).toBe(false)
        }
        expect(`${reason}${status}`, label).not.toBe("")
      }
    }
  })

  it("never offers a decision on the read-only view", async () => {
    const { decisions } = decisionsOf({ "job-1": NOW + 60_000 })
    const host = await mount({ decisions, externalLinks: "disabled", snapshots: snapshotsOf([request("r1", "job-1")]) })
    expect(button(host, "Approve: Apply r1")).toBeUndefined()
    expect(host.textContent).toContain("Approve this on the hub (HUB).")
  })
})
