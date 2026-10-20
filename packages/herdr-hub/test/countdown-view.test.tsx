// @vitest-environment happy-dom

import { describe, expect, it, vi } from "@effect/vitest"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { AgentCreature } from "@knpkv/herdr-connect/surface"
import type { ApprovalDecision } from "../src/approval-decision.js"
import { ApprovalsCountdown, type DecisionStatus } from "../src/countdown-view.js"
import type { DashboardSnapshot } from "../src/dashboard-model.js"

Object.assign(window, { IS_REACT_ACT_ENVIRONMENT: true })

/** One fixed snapshot time, so "the same read" and "a newer read" never depend on the clock ticking. */
const OBSERVED_AT = 1_800_000_000_000

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

interface Props {
  readonly decisionStatus?: DecisionStatus | null
  readonly refreshFailed?: boolean
  readonly sending?: ApprovalDecision | null
  readonly snapshot: DashboardSnapshot
}

const mount = (initial: Props) => {
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  const decisions: Array<ApprovalDecision> = []
  const revalidations = { count: 0 }
  const render = (props: Props) =>
    act(() =>
      root.render(
        <ApprovalsCountdown
          decisionStatus={props.decisionStatus ?? null}
          historyLoading={false}
          onDecision={(decision) => decisions.push(decision)}
          onLoadHistory={undefined}
          onLoadPending={undefined}
          onRevalidate={() => {
            revalidations.count += 1
          }}
          pendingLoading={false}
          refreshFailed={props.refreshFailed ?? false}
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
  return { bar, container, decisions, press, render, revalidations, unmount }
}

describe("ApprovalsCountdown", () => {
  it("keeps history cards compact and folds complete audit arguments below them", () => {
    const view = mount({
      snapshot: snapshot({ records: [record("finished", { approvedAt: Date.now() - 3_600_000, approvedBy: "owner" })] })
    })
    const card = view.container.querySelector(".countdown-decided-row")
    expect(card?.querySelector("details")).toBeNull()
    expect(card?.querySelector(".countdown-row-caption")?.textContent).toBe("by owner, 1h ago")
    const audit = view.container.querySelector<HTMLDetailsElement>(".countdown-history-audit")
    expect(audit).not.toBeNull()
    expect(audit?.open).toBe(false)
    expect(audit?.querySelector("summary")?.textContent).toBe("Decision request arguments")
    expect(audit?.textContent).toContain("main")
    view.unmount()
  })

  it("shows normalized JSON arguments without private delegation prompt text", () => {
    const view = mount({
      snapshot: snapshot({
        pendingApprovals: {
          failures: [],
          remote: [],
          nextCursors: [],
          local: [
            record("review", {
              payload: {
                kind: "agent.delegate",
                mode: "review",
                repository: "/workspace/project",
                prompt: "private instructions must stay private"
              }
            })
          ]
        }
      })
    })
    const code = view.container.querySelector(".countdown-selected .approval-request-json")
    expect(code).not.toBeNull()
    expect(code?.textContent).toContain('"kind": "agent.delegate"')
    expect(code?.textContent).toContain("[redacted internal prompt]")
    expect(code?.textContent).not.toContain("private instructions must stay private")
    view.unmount()
  })

  it("places requester identity beneath the window track and gives history its kind", () => {
    const view = mount({
      snapshot: snapshot({ records: [record("finished", { approvedAt: Date.now(), approvedBy: "owner" })] })
    })
    const caption = view.container.querySelector(".countdown-row-caption")
    expect(caption?.querySelector(".countdown-requester")).not.toBeNull()
    expect(caption?.textContent).toContain("from submitter@example.com")
    expect(view.container.querySelector(".countdown-decided-row .countdown-decided-kind")?.textContent).toBe(
      "nix.apply"
    )
    expect(view.container.querySelector(".countdown-request-header")?.textContent).toContain(
      "Requested by submitter@example.com"
    )
    view.unmount()
  })

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
      /^\dm \d\ds left on Apply nix ref main, expires soon$/
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
    expect(view.container.querySelector(".countdown-pending-count")?.textContent).toBe("Requests on 1 host unchecked")
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
                payload: { kind: "nix.check" },
                status: "pending_approval"
              },
              approvalUrl: "https://beta.example.test/approve/remote-1",
              host: "BETA"
            }
          ]
        }
      })
    })
    // Decided on its own host: no inert bar, the review link is the action.
    expect(view.bar()).toBeNull()
    expect(view.container.querySelector(".countdown-remote-note")?.textContent).toBe("Approve or reject it on BETA.")
    expect(view.container.querySelector("a.countdown-review-link")?.getAttribute("href")).toBe(
      "https://beta.example.test/approve/remote-1"
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
      decisionStatus: {
        jobId: "job-1",
        observedAt: OBSERVED_AT,
        settles: true,
        text: "The hub refused: this request already changed.",
        outcome: "refused",
        expiresAt: undefined
      },
      snapshot: snapshot()
    })
    expect(view.bar()?.querySelector("[role='status']")?.textContent).toBe(
      "The hub refused: this request already changed."
    )
    view.unmount()
  })

  const decidedElsewhere: ReadonlyArray<readonly [string, Partial<JobRecord>]> = [
    ["Approved", { approvedAt: Date.now() - 2 * 60_000, approvedBy: "owner@example.com", status: "queued" }],
    ["Rejected", { rejectedAt: Date.now() - 2 * 60_000, rejectedBy: "owner@example.com", status: "rejected" }]
  ]
  it.each(decidedElsewhere)(
    "shows a request decided elsewhere as a %s badge, who and when beside it",
    (word, decided) => {
      const view = mount({ snapshot: snapshot() })
      act(() => view.container.querySelector<HTMLButtonElement>("[data-countdown-row]")?.click())
      view.render({
        snapshot: snapshot({
          pendingApprovals: { failures: [], local: [], nextCursors: [], remote: [] },
          records: [record("job-1", decided)]
        })
      })
      const status = view.bar()?.querySelector("[role='status']")
      const badge = status?.firstElementChild
      expect(badge?.textContent).toBe(word)
      expect(badge?.querySelector("svg")).not.toBeNull()
      expect(status?.lastElementChild?.textContent).toBe("by owner@example.com, 2m ago")
      view.unmount()
    }
  )

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
    expect(view.bar()?.querySelector("[role='status']")?.textContent).toBe("ExpiredNothing was applied.")
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
      decisionStatus: {
        jobId: "job-1",
        observedAt: OBSERVED_AT,
        settles: true,
        text: "The hub recorded your approval; the job is queued.",
        outcome: "accepted",
        expiresAt: undefined
      },
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
    expect(view.bar()?.querySelector("[role='status']")?.textContent).toBe("ExpiredNothing was applied.")
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
        payload: { kind: "nix.check" },
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
    expect(view.container.querySelector(".countdown-remote-status")?.textContent).toBe(
      "This request left BETA's queue."
    )
    view.unmount()
  })

  it("keeps a request off once the hub refused it", () => {
    const view = mount({
      decisionStatus: {
        jobId: "job-1",
        observedAt: OBSERVED_AT,
        settles: true,
        text: "The hub refused: this request already changed.",
        outcome: "refused",
        expiresAt: undefined
      },
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
      "Apply nix ref main (job-2) on ALPHA expired. Nothing was applied."
    )
    view.unmount()
  })

  it("lets a refused request be retried once a newer read still lists it as decidable", () => {
    const answeredAt = Date.now() - 1_000
    const status: DecisionStatus = {
      jobId: "job-1",
      observedAt: answeredAt,
      settles: true,
      text: "The hub refused.",
      outcome: "refused",
      expiresAt: undefined
    }
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
        payload: { kind: "nix.check" },
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
    expect(view.container.querySelector(".countdown-remote-status")?.textContent).toBe("")
    expect(view.container.querySelector(".countdown-kicker")?.textContent).toContain("job-9")
    view.unmount()
  })

  it("says a request without an expiry has none, in the row and on its bar", () => {
    const view = mount({
      snapshot: snapshot({
        pendingApprovals: {
          failures: [],
          local: [record("job-1", { approvalExpiresAt: null })],
          nextCursors: [],
          remote: []
        }
      })
    })
    expect(view.container.querySelector(".countdown-row-clock")?.textContent).toBe("No expiry")
    expect(view.container.querySelector(".countdown-detail")?.textContent).toContain("No expiry")
    view.unmount()
  })

  it("admits that a later page may hold a sooner deadline", () => {
    const view = mount({
      snapshot: snapshot({
        pendingApprovals: {
          failures: [],
          local: [record("job-1")],
          nextCursors: [{ cursor: { createdAt: 1, id: "job-1" }, host: "ALPHA" }],
          remote: []
        }
      })
    })
    expect(view.container.querySelector("[aria-label='Approval summary']")?.textContent).toContain(
      "More requests aren't loaded yet; one of them may expire sooner."
    )
    // The count is what's listed; the hero says in words that more may come.
    expect(view.container.querySelector(".countdown-waiting h2")?.textContent).toBe("Waiting for you 1")
    view.unmount()
  })

  it("announces a local answer while a remote request with the same id is selected", () => {
    const remote: DashboardSnapshot["pendingApprovals"]["remote"][number] = {
      approval: {
        actor: "ops@example.com",
        approvalExpiresAt: Date.now() + 9 * 60_000,
        createdAt: Date.now(),
        id: "job-1",
        payload: { kind: "nix.check" },
        status: "pending_approval"
      },
      approvalUrl: "https://beta.example.test/approve/job-1",
      host: "BETA"
    }
    const pending = { failures: [], local: [record("job-1")], nextCursors: [], remote: [remote] }
    const view = mount({ snapshot: snapshot({ pendingApprovals: pending }) })
    act(() => view.container.querySelector<HTMLButtonElement>("[data-approval-host='BETA']")?.click())
    view.render({
      decisionStatus: {
        jobId: "job-1",
        observedAt: OBSERVED_AT,
        settles: true,
        text: "The hub recorded your approval.",
        outcome: "accepted",
        expiresAt: undefined
      },
      snapshot: snapshot({ pendingApprovals: pending })
    })
    expect(view.container.querySelector(".countdown-announcer")?.textContent).toBe("The hub recorded your approval.")
    view.unmount()
  })

  it("asks the hub once when a deadline passes, instead of expiring it locally", () => {
    const view = mount({
      snapshot: snapshot({
        pendingApprovals: {
          failures: [],
          local: [record("job-1", { approvalExpiresAt: Date.now() - 1_000 })],
          nextCursors: [],
          remote: []
        }
      })
    })
    expect(view.revalidations.count).toBe(1)
    expect(view.bar()?.dataset["state"]).toBe("ready")
    view.render({
      snapshot: snapshot({
        pendingApprovals: {
          failures: [],
          local: [record("job-1", { approvalExpiresAt: Date.now() - 1_000 })],
          nextCursors: [],
          remote: []
        }
      })
    })
    expect(view.revalidations.count).toBe(1)
    view.unmount()
  })

  it("replaces an uncertain answer with the outcome a later read proves", () => {
    const view = mount({ snapshot: snapshot() })
    const status: DecisionStatus = {
      jobId: "job-1",
      observedAt: OBSERVED_AT,
      settles: false,
      text: "The hub didn't confirm the decision.",
      outcome: "uncertain",
      expiresAt: undefined
    }
    view.render({ decisionStatus: status, snapshot: snapshot() })
    expect(view.bar()?.querySelector("[role='status']")?.textContent).toBe("The hub didn't confirm the decision.")
    view.render({
      decisionStatus: status,
      snapshot: snapshot({
        pendingApprovals: { failures: [], local: [], nextCursors: [], remote: [] },
        records: [record("job-1", { expiredAt: Date.now(), status: "expired" })]
      })
    })
    expect(view.bar()?.querySelector("[role='status']")?.textContent).toBe("ExpiredNothing was applied.")
    view.unmount()
  })

  it("keeps list semantics on the styled lists", () => {
    const view = mount({
      snapshot: snapshot({
        records: [record("old", { approvedAt: Date.now(), approvedBy: "owner@example.com", status: "queued" })]
      })
    })
    const lists = [...view.container.querySelectorAll(".countdown-rows")]
    expect(lists.length).toBe(2)
    expect(lists.every((list) => list.getAttribute("role") === "list")).toBe(true)
    view.unmount()
  })

  it("keeps the summary provisional when the first page is empty but more remain", () => {
    const view = mount({
      snapshot: snapshot({
        pendingApprovals: {
          failures: [],
          local: [],
          nextCursors: [{ cursor: { createdAt: 1, id: "job-1" }, host: "ALPHA" }],
          remote: []
        }
      })
    })
    expect(view.container.querySelector("[aria-label='Approval summary'] p")?.textContent).toBe(
      "Nothing on the first page; more requests aren't loaded yet"
    )
    view.unmount()
  })

  it("shows a confirmed expiry over an earlier refusal", () => {
    const status: DecisionStatus = {
      jobId: "job-1",
      observedAt: OBSERVED_AT,
      settles: true,
      text: "The hub refused.",
      outcome: "refused",
      expiresAt: undefined
    }
    const view = mount({ decisionStatus: status, snapshot: snapshot() })
    view.render({
      decisionStatus: status,
      snapshot: snapshot({
        observedAt: OBSERVED_AT + 5_000,
        pendingApprovals: { failures: [], local: [], nextCursors: [], remote: [] },
        records: [record("job-1", { expiredAt: Date.now(), status: "expired" })]
      })
    })
    expect(view.bar()?.querySelector("[role='status']")?.textContent).toBe("ExpiredNothing was applied.")
    view.unmount()
  })

  it("says each row's used share of its approval window in words", () => {
    const view = mount({ snapshot: snapshot() })
    expect(view.container.querySelector("[data-countdown-row] .countdown-visually-hidden")?.textContent).toMatch(
      /^, \d+% of its approval window used$/
    )
    view.unmount()
  })

  it("reads expiries on the hub's clock, not a browser clock that runs ahead", () => {
    const hubNow = Date.now() - 10 * 60_000
    const view = mount({
      snapshot: snapshot({
        observedAt: hubNow,
        pendingApprovals: {
          failures: [],
          local: [record("job-1", { approvalExpiresAt: hubNow + 2 * 60_000 + 30_000 })],
          nextCursors: [],
          remote: []
        }
      })
    })
    expect(view.container.querySelector("[aria-label='Approval summary'] p")?.textContent).toMatch(/^2m \d\ds left on /)
    expect(view.revalidations.count).toBe(0)
    view.unmount()
  })

  it("says expiring once at the deadline, without 'about to expire'", () => {
    const view = mount({
      snapshot: snapshot({
        pendingApprovals: {
          failures: [],
          local: [record("job-1", { approvalExpiresAt: Date.now() - 1_000 })],
          nextCursors: [],
          remote: []
        }
      })
    })
    expect(view.container.querySelector("[aria-label='Approval summary'] p")?.textContent).toBe(
      "Apply nix ref main is expiring"
    )
    view.unmount()
  })

  it("does not keep a local request decidable because another host has more pages", () => {
    const view = mount({ snapshot: snapshot() })
    view.render({
      snapshot: snapshot({
        pendingApprovals: {
          failures: [],
          local: [],
          nextCursors: [{ cursor: { createdAt: 1, id: "remote-9" }, host: "BETA" }],
          remote: []
        }
      })
    })
    expect(view.bar()?.dataset["state"]).toBe("off")
    view.press("Enter")
    expect(view.decisions).toEqual([])
    view.unmount()
  })

  it("keeps a local request usable while this host's own queue has more pages", () => {
    const view = mount({ snapshot: snapshot() })
    view.render({
      snapshot: snapshot({
        pendingApprovals: {
          failures: [],
          local: [],
          nextCursors: [{ cursor: { createdAt: 1, id: "job-9" }, host: "alpha" }],
          remote: []
        }
      })
    })
    expect(view.bar()?.dataset["state"]).toBe("ready")
    view.unmount()
  })

  it("still asks the hub at the deadline of a pinned request that left the loaded pages", () => {
    vi.useFakeTimers()
    try {
      const listed = snapshot({
        pendingApprovals: {
          failures: [],
          local: [record("job-1", { approvalExpiresAt: Date.now() + 2_000 })],
          nextCursors: [],
          remote: []
        }
      })
      const view = mount({ snapshot: listed })
      // Gone from the loaded page, but this host has more pages: not proven gone.
      view.render({
        snapshot: {
          ...listed,
          pendingApprovals: {
            failures: [],
            local: [],
            nextCursors: [{ cursor: { createdAt: 1, id: "job-9" }, host: "ALPHA" }],
            remote: []
          }
        }
      })
      expect(view.revalidations.count).toBe(0)
      // One second per act: React schedules each next tick only after it renders the last.
      for (let second = 0; second < 3; second += 1) act(() => vi.advanceTimersByTime(1_000))
      expect(view.revalidations.count).toBe(1)
      view.unmount()
    } finally {
      vi.useRealTimers()
    }
  })

  it("does not ask the hub about a pinned request whose expiry it already recorded", () => {
    vi.useFakeTimers()
    try {
      const listed = snapshot({
        pendingApprovals: {
          failures: [],
          local: [record("job-1", { approvalExpiresAt: Date.now() + 2_000 })],
          nextCursors: [],
          remote: []
        }
      })
      const view = mount({ snapshot: listed })
      view.render({
        snapshot: {
          ...listed,
          pendingApprovals: { failures: [], local: [], nextCursors: [], remote: [] },
          records: [record("job-1", { expiredAt: Date.now(), status: "expired" })]
        }
      })
      for (let second = 0; second < 20; second += 1) act(() => vi.advanceTimersByTime(1_000))
      expect(view.revalidations.count).toBe(0)
      view.unmount()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("approval request presentation", () => {
  it("draws the exact requester identity only in the row and request header", () => {
    const base = snapshot()
    const view = mount({
      snapshot: {
        ...base,
        pendingApprovals: { ...base.pendingApprovals, local: [record("job-1", { actor: "build-bot" })] },
        status: {
          ...base.status,
          herdr: {
            available: true,
            error: null,
            agents: [
              {
                agentId: "agent-builder",
                activityRevision: 1,
                kind: "codex",
                name: "build-bot",
                paneId: "w1:p1",
                parentAgentId: null,
                relation: null,
                status: "working",
                work: "release"
              }
            ]
          }
        }
      }
    })
    const expectedContainer = document.createElement("div")
    const expectedRoot = createRoot(expectedContainer)
    act(() => expectedRoot.render(<AgentCreature host="ALPHA" id="agent-builder" size="row" state="waiting" />))
    const expectedBody = expectedContainer.querySelector(".connect-creature-body")?.getAttribute("d")
    const portraits = view.container.querySelectorAll(".countdown-requester .connect-creature")
    expect(portraits).toHaveLength(2)
    for (const portrait of portraits) {
      expect(portrait.querySelector(".connect-creature-body")?.getAttribute("d")).toBe(expectedBody)
      expect(portrait.getAttribute("data-bucket")).toBe("needs-you")
    }
    expect(view.bar()?.querySelector("svg.connect-creature")).toBeNull()
    act(() => expectedRoot.unmount())
    view.unmount()
  })

  it("retains a remote actor without inventing a creature identity", () => {
    const view = mount({
      snapshot: snapshot({
        pendingApprovals: {
          failures: [],
          local: [],
          nextCursors: [],
          remote: [
            {
              host: "BETA",
              approvalUrl: "https://beta.example.test/",
              approval: {
                actor: "remote-bot",
                approvalExpiresAt: Date.now() + 60_000,
                createdAt: Date.now(),
                id: "remote-1",
                payload: { kind: "nix.apply", ref: "main" },
                status: "pending_approval"
              }
            }
          ]
        }
      })
    })
    expect(view.container.querySelector(".countdown-requester-name")?.textContent).toBe("remote-bot")
    expect(view.container.querySelector(".countdown-requester-placeholder")?.getAttribute("aria-label")).toBe(
      "Requester portrait unavailable"
    )
    expect(view.container.querySelector(".connect-creature")).toBeNull()
    view.unmount()
  })

  it("labels an unreadable requester instead of leaving the name blank", () => {
    const view = mount({
      snapshot: snapshot({
        pendingApprovals: { failures: [], local: [record("job-1", { actor: " " })], nextCursors: [], remote: [] }
      })
    })
    expect(view.container.querySelector(".countdown-requester-name")?.textContent).toBe("Requester unreadable")
    view.unmount()
  })

  it("says No requests waiting for a fully read empty queue", () => {
    const view = mount({
      snapshot: snapshot({ pendingApprovals: { failures: [], local: [], nextCursors: [], remote: [] } })
    })
    expect(view.container.querySelector(".countdown-empty")?.textContent).toBe("No requests waiting")
    view.unmount()
  })

  it("retains the selected request and retries a failed host read", () => {
    const view = mount({ snapshot: snapshot() })
    view.render({
      snapshot: snapshot({
        pendingApprovals: {
          failures: [{ host: "ALPHA", reason: "request_failed" }],
          local: [],
          nextCursors: [],
          remote: []
        }
      })
    })
    expect(view.container.querySelector(".countdown-kicker")?.textContent).toContain("job-1")
    const retry = [...view.container.querySelectorAll("button")].find((button) => button.textContent === "Retry")
    expect(retry).toBeDefined()
    act(() => retry?.click())
    expect(view.revalidations.count).toBe(1)
    expect(view.decisions).toEqual([])
    view.unmount()
  })
})

describe("stale approval decisions", () => {
  const age = () => {
    for (let second = 0; second < 31; second += 1) act(() => vi.advanceTimersByTime(1_000))
  }

  it("revalidates before sending a stale decision and sends only the unchanged request", () => {
    vi.useFakeTimers()
    try {
      const initial = snapshot()
      const view = mount({ snapshot: initial })
      age()
      expect(view.container.querySelector(".countdown-freshness")?.textContent).toContain("Last checked")
      view.press("Enter")
      expect(view.revalidations.count).toBe(1)
      expect(view.decisions).toEqual([])
      view.press("Enter")
      expect(view.revalidations.count).toBe(1)
      view.render({ snapshot: { ...initial, observedAt: Date.now() } })
      expect(view.decisions).toEqual([{ decision: "approve", jobId: "job-1" }])
      view.unmount()
    } finally {
      vi.useRealTimers()
    }
  })

  it("shows changed arguments without sending the stale approval", () => {
    vi.useFakeTimers()
    try {
      const initial = snapshot()
      const view = mount({ snapshot: initial })
      age()
      view.press("Enter")
      expect(view.decisions).toEqual([])
      view.render({
        snapshot: {
          ...initial,
          observedAt: Date.now(),
          pendingApprovals: {
            ...initial.pendingApprovals,
            local: [record("job-1", { payload: { kind: "nix.apply", ref: "release" } })]
          }
        }
      })
      expect(view.decisions).toEqual([])
      expect(view.container.querySelector(".countdown-verification")?.textContent).toContain("changed")
      view.unmount()
    } finally {
      vi.useRealTimers()
    }
  })

  it("keeps an expired outcome inactive after the stale read", () => {
    vi.useFakeTimers()
    try {
      const initial = snapshot()
      const view = mount({ snapshot: initial })
      age()
      view.press("Enter")
      expect(view.decisions).toEqual([])
      view.render({
        snapshot: {
          ...initial,
          observedAt: Date.now(),
          pendingApprovals: {
            failures: [],
            local: [],
            nextCursors: [],
            remote: []
          },
          records: [record("job-1", { expiredAt: Date.now(), status: "expired" })]
        }
      })
      expect(view.decisions).toEqual([])
      expect(view.bar()?.dataset["state"]).toBe("off")
      expect(view.bar()?.textContent).toContain("Expired")
      view.unmount()
    } finally {
      vi.useRealTimers()
    }
  })

  it("cancels a stale decision when the reader selects another request", () => {
    vi.useFakeTimers()
    try {
      const initial = snapshot({
        pendingApprovals: { failures: [], local: [record("job-1"), record("job-2")], nextCursors: [], remote: [] }
      })
      const view = mount({ snapshot: initial })
      age()
      view.press("Enter")
      act(() => view.container.querySelector<HTMLButtonElement>("[data-approval-job='job-2']")?.click())
      view.render({ snapshot: { ...initial, observedAt: Date.now() } })
      expect(view.decisions).toEqual([])
      view.unmount()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("failed stale validation", () => {
  it("cancels a pending stale decision when refresh fails, including after a later success", () => {
    vi.useFakeTimers()
    try {
      const initial = snapshot()
      const view = mount({ snapshot: initial })
      for (let second = 0; second < 31; second += 1) act(() => vi.advanceTimersByTime(1_000))
      view.press("Enter")
      expect(view.decisions).toEqual([])
      view.render({ snapshot: initial, refreshFailed: true })
      expect(view.bar()?.dataset["state"]).toBe("off")
      expect(view.container.querySelector(".countdown-verification")?.textContent).toContain("Couldn't check")
      expect([...view.container.querySelectorAll("button")].some((button) => button.textContent === "Retry")).toBe(true)
      view.render({ snapshot: { ...initial, observedAt: Date.now() } })
      expect(view.decisions).toEqual([])
      view.unmount()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("full approval request", () => {
  it("keeps the visible target, disclosure arguments and decision on the selected request", () => {
    const initial = snapshot({
      pendingApprovals: {
        failures: [],
        local: [
          record("job-1", { payload: { kind: "nix.apply", ref: "main@1234567" } }),
          record("job-2", {
            approvalExpiresAt: Date.now() + 20 * 60_000,
            payload: { kind: "nix.apply", ref: "release@7654321" }
          })
        ],
        nextCursors: [],
        remote: []
      }
    })
    const view = mount({ snapshot: initial })
    expect(view.container.querySelector(".countdown-request-target")?.textContent).toBe("main@1234567")
    const disclosure = view.container.querySelector<HTMLDetailsElement>(".countdown-selected details")
    expect(disclosure?.querySelector("summary")?.textContent).toBe("Full request")
    expect(disclosure?.textContent).toContain("Applies this Nix revision on ALPHA.")
    act(() => {
      if (disclosure !== null) disclosure.open = true
    })
    view.render({
      snapshot: {
        ...initial,
        pendingApprovals: { ...initial.pendingApprovals, local: [...initial.pendingApprovals.local].reverse() }
      }
    })
    expect(view.container.querySelector(".countdown-selected details")?.hasAttribute("open")).toBe(true)
    expect(view.container.querySelector(".countdown-selected .approval-request-json")?.textContent).toContain(
      '"ref": "main@1234567"'
    )
    view.press("Enter")
    expect(view.decisions).toEqual([{ decision: "approve", jobId: "job-1" }])
    view.unmount()
  })

  it("never draws a target worker as the requester", () => {
    const view = mount({
      snapshot: snapshot({
        pendingApprovals: {
          failures: [],
          local: [
            record("job-1", { worker: { agentId: "agent-target", host: "ALPHA", name: "target-bot", paneId: "w1:p1" } })
          ],
          nextCursors: [],
          remote: []
        }
      })
    })
    expect(view.container.querySelector(".connect-creature")).toBeNull()
    expect(view.container.querySelector(".countdown-requester-name")?.textContent).toBe("submitter@example.com")
    view.unmount()
  })

  it("keeps ticking clocks outside live regions", () => {
    vi.useFakeTimers()
    try {
      const view = mount({ snapshot: snapshot() })
      const before = view.container.querySelector(".countdown-announcer")?.textContent
      for (let second = 0; second < 3; second += 1) act(() => vi.advanceTimersByTime(1_000))
      for (const clock of view.container.querySelectorAll(".countdown-row-clock")) {
        expect(clock.closest("[aria-live], [role='status']")).toBeNull()
      }
      expect(view.container.querySelector(".countdown-announcer")?.textContent).toBe(before)
      view.unmount()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("requester identity boundaries", () => {
  it("does not infer a requester from a target worker sharing its name on another host", () => {
    const view = mount({
      snapshot: snapshot({
        pendingApprovals: {
          failures: [],
          local: [
            record("job-1", {
              actor: "build-bot",
              worker: { agentId: "agent-target", host: "BETA", name: "build-bot", paneId: "w1:p1" }
            })
          ],
          nextCursors: [],
          remote: []
        }
      })
    })
    expect(view.container.querySelector(".connect-creature")).toBeNull()
    expect(view.container.querySelector(".countdown-requester-name")?.textContent).toBe("build-bot")
    view.unmount()
  })
})
