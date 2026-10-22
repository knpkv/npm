import { describe, expect, it } from "@effect/vitest"
import { Data, Effect, Result } from "effect"
import { type SanitizedJobRecord, sanitizeJobRecord } from "../src/approval-request.js"
import { authorize } from "../src/auth.js"
import type { DashboardSnapshot, PendingApprovalTarget } from "../src/dashboard-model.js"
import {
  dashboardPendingBadgeCount,
  pendingApprovalTargetAfterRevalidation,
  withPendingApprovalTarget
} from "../src/internal/dashboard-pending-state.js"
import {
  approvalDeepLink,
  type ApprovalWorkerClients,
  type ApprovalWorkerRegistration,
  handleNotificationClick,
  matchesApprovalDeepLink,
  readApprovalDeepLink,
  showApprovalNotification
} from "../src/pwa.js"

class ClientOperationFailed extends Data.TaggedError("ClientOperationFailed")<{ readonly operation: string }> {}

/** A notification click permits one focus or open operation, even when that operation fails. */
const windowInteractionGrant = () => {
  let available = true
  return () => {
    if (!available) throw new DOMException("Window interaction already consumed", "InvalidAccessError")
    available = false
  }
}

/** A pending job as the dashboard receives it: the sanitized projection of the host's record. */
const approvalRecord = (id: string): SanitizedJobRecord =>
  sanitizeJobRecord({
    actor: "owner@example.com",
    approvalNonce: `nonce-${id}`,
    approvedBy: null,
    createdAt: 1,
    error: null,
    hash: "a".repeat(64),
    id,
    payload: { kind: "nix.check" },
    result: null,
    status: "pending_approval",
    updatedAt: 1
  })

describe("approval PWA", () => {
  it("removes a cached deep-link card after definitive revalidation", () => {
    const cached = {
      _tag: "local",
      record: approvalRecord("job-deep-link")
    } satisfies PendingApprovalTarget
    const refreshed = {
      approvalApp: {
        canonical: true,
        canonicalUrl: "https://ser8.example.test:4779/",
        pushEnabled: true,
        superapp: true,
        fleet: true,
        workEnabled: false,
        sandboxesEnabled: false
      },
      approvalsEnabled: true,
      directory: null,
      historyNextCursor: null,
      host: "SER8",
      observedAt: 2,
      pendingApprovals: { failures: [], local: [], nextCursors: [], remote: [] },
      records: [],
      status: {
        applyConfigured: false,
        herdr: { agents: [], available: true, error: null },
        host: "SER8",
        repository: { branch: "main", dirty: false, path: "/repo", revision: "abc123" }
      },
      work: null
    } satisfies DashboardSnapshot

    expect(withPendingApprovalTarget(refreshed, cached).pendingApprovals.local).toHaveLength(1)
    expect(
      withPendingApprovalTarget(
        refreshed,
        pendingApprovalTargetAfterRevalidation(cached, { _tag: "Missing" })
      ).pendingApprovals.local
    ).toEqual([])
    expect(
      pendingApprovalTargetAfterRevalidation(cached, { _tag: "Retry" })
    ).toEqual(cached)
    expect(
      withPendingApprovalTarget(
        refreshed,
        pendingApprovalTargetAfterRevalidation(cached, { _tag: "Found", target: cached })
      ).pendingApprovals.local.map(({ id }) => id)
    ).toEqual(["job-deep-link"])
  })

  it("preserves the existing badge until every pending page is loaded", () => {
    expect(
      dashboardPendingBadgeCount({
        failures: [],
        local: Array.from({ length: 8 }, (_, index) => approvalRecord(`job-${String(index)}`)),
        nextCursors: [{ cursor: { createdAt: 1, id: "job-cursor" }, host: "SER8" }],
        remote: []
      }, 3)
    ).toBeNull()
    expect(
      dashboardPendingBadgeCount({
        failures: [],
        local: Array.from({ length: 9 }, (_, index) => approvalRecord(`job-${String(index)}`)),
        nextCursors: [],
        remote: []
      }, 3)
    ).toBe(9)
  })

  it.effect("trusts only header-free loopback requests", () =>
    Effect.gen(function*() {
      expect(
        yield* authorize(
          { login: undefined, remoteAddress: "127.0.0.1" },
          ["owner@example.com"],
          true
        )
      ).toBe("local")
      const forwarded = yield* Effect.result(
        authorize(
          { login: "owner@example.com", remoteAddress: undefined },
          ["owner@example.com"],
          false
        )
      )
      expect(Result.isFailure(forwarded)).toBe(true)
      const spoofed = yield* Effect.result(
        authorize(
          { login: "owner@example.com", remoteAddress: "100.64.0.2" },
          ["owner@example.com"],
          false
        )
      )
      expect(Result.isFailure(spoofed)).toBe(true)
    }))

  it("sets the badge before showing the bounded approval payload", async () => {
    const events: Array<string> = []
    const registration: ApprovalWorkerRegistration = {
      scope: "https://ser8.example.ts.net/",
      showNotification: (title, options) => {
        events.push(`${title}:${options.body}`)
        return Promise.resolve()
      }
    }
    await showApprovalNotification(
      registration,
      (count) => {
        events.push(`badge:${String(count)}`)
        return Promise.resolve()
      },
      { host: "PI", jobId: "job-7", pendingCount: 3 }
    )
    expect(events).toEqual([
      "badge:3",
      "Approval needed on PI:Job job-7 is waiting for approval."
    ])
  })

  it("preserves the badge when the fleet count is incomplete", async () => {
    const events: Array<string> = []
    const registration: ApprovalWorkerRegistration = {
      scope: "https://ser8.example.ts.net/",
      showNotification: (title) => {
        events.push(title)
        return Promise.resolve()
      }
    }
    await showApprovalNotification(
      registration,
      (count) => {
        events.push(`badge:${String(count)}`)
        return Promise.resolve()
      },
      { host: "SER8", jobId: "job-local", pendingCount: null }
    )
    expect(events).toEqual(["Approval needed on SER8"])
  })

  it("still shows the notification when badge update fails", async () => {
    const notifications: Array<string> = []
    const registration: ApprovalWorkerRegistration = {
      scope: "https://ser8.example.ts.net/",
      showNotification: (title) => {
        notifications.push(title)
        return Promise.resolve()
      }
    }
    await expect(
      showApprovalNotification(
        registration,
        () => Promise.reject(new Error("badging unavailable")),
        { host: "PI", jobId: "job-7", pendingCount: 3 }
      )
    ).rejects.toMatchObject({ _tag: "UnknownError" })
    expect(notifications).toEqual(["Approval needed on PI"])
  })

  it("builds and decodes a sanitized individual approval deep link", () => {
    const url = approvalDeepLink("https://ser8.example.ts.net/", {
      host: "PI 5",
      jobId: "job/7"
    })
    expect(url).toBe(
      "https://ser8.example.ts.net/?tab=approvals&approvalHost=PI+5&approvalJob=job%2F7"
    )
    const decoded = readApprovalDeepLink(new URL(url).search)
    expect(Result.isSuccess(decoded)).toBe(true)
    if (Result.isSuccess(decoded)) {
      expect(decoded.success).toEqual({ host: "PI 5", jobId: "job/7" })
    }
  })

  it("rejects malformed individual approval deep links", () => {
    const decoded = readApprovalDeepLink("?approvalHost=PI")
    expect(Result.isFailure(decoded)).toBe(true)
    if (Result.isFailure(decoded)) expect(decoded.failure._tag).toBe("ApprovalDeepLinkError")
  })

  it("matches approval hosts case-insensitively without widening job identity", () => {
    const target = { host: "PI", jobId: "job-7" }
    expect(
      matchesApprovalDeepLink(
        { approvalHost: "pi", approvalJob: "job-7" },
        target
      )
    ).toBe(true)
    expect(
      matchesApprovalDeepLink(
        { approvalHost: "ser8", approvalJob: "job-7" },
        target
      )
    ).toBe(false)
    expect(
      matchesApprovalDeepLink(
        { approvalHost: "pi", approvalJob: "JOB-7" },
        target
      )
    ).toBe(false)
  })

  it("navigates before focusing the returned canonical approval window with one grant", async () => {
    const order: Array<string> = []
    const focused: Array<string> = []
    const navigated: Array<string> = []
    const opened: Array<string> = []
    const consume = windowInteractionGrant()
    const clients: ApprovalWorkerClients = {
      matchAll: () =>
        Promise.resolve([
          {
            focus: () => {
              consume()
              order.push("focus:original")
              focused.push("original")
              return Promise.resolve()
            },
            navigate: (url) => {
              order.push("navigate")
              navigated.push(url)
              return Promise.resolve({
                focus: async () => {
                  consume()
                  order.push("focus:navigated")
                  focused.push("navigated")
                }
              })
            },
            url: "https://ser8.example.ts.net/?tab=connect"
          }
        ]),
      openWindow: (url) => {
        consume()
        opened.push(url)
        return Promise.resolve()
      }
    }
    const target = "https://ser8.example.ts.net/?tab=approvals&approvalHost=PI&approvalJob=job-7"
    await handleNotificationClick(clients, target)
    expect(order).toEqual(["navigate", "focus:navigated"])
    expect(navigated).toEqual([target])
    expect(focused).toEqual(["navigated"])
    expect(opened).toEqual([])
  })

  it("opens the individual approval deep link when the app is closed", async () => {
    const opened: Array<string> = []
    const consume = windowInteractionGrant()
    const clients: ApprovalWorkerClients = {
      matchAll: () => Promise.resolve([]),
      openWindow: (url) => {
        consume()
        opened.push(url)
        return Promise.resolve()
      }
    }
    const target = "https://ser8.example.ts.net/?tab=approvals&approvalHost=PI&approvalJob=job-7"
    await handleNotificationClick(clients, target)
    expect(opened).toEqual([target])
  })
  it("opens a new window instead of navigating an uncontrolled same-origin window", async () => {
    const events: Array<string> = []
    const clients: ApprovalWorkerClients = {
      matchAll: (options?: { readonly includeUncontrolled?: boolean; readonly type?: string }) =>
        Promise.resolve(
          options?.includeUncontrolled === false ? [] : [{
            url: "https://hub.example.test/",
            focus: async () => {
              events.push("focus")
            },
            navigate: async () => {
              events.push("navigate")
              throw new ClientOperationFailed({ operation: "uncontrolled" })
            }
          }]
        ),
      openWindow: async (url) => {
        events.push(url)
      }
    }
    const target = "https://hub.example.test/connect/?host=HOST-A&agent=agent-one&open=stage"
    await handleNotificationClick(clients, target)
    expect(events).toEqual([target])
  })
  it.each(["rejected", "null"])("opens the deep link when navigation is %s", async (outcome) => {
    const events: Array<string> = []
    const consume = windowInteractionGrant()
    const clients: ApprovalWorkerClients = {
      matchAll: async () => [{
        url: "https://hub.example.test/",
        focus: async () => {
          consume()
          events.push("focus")
        },
        navigate: async () => {
          events.push("navigate")
          if (outcome === "rejected") throw new ClientOperationFailed({ operation: "navigate" })
          return null
        }
      }],
      openWindow: async (url) => {
        consume()
        events.push(url)
      }
    }
    const target = "https://hub.example.test/connect/?host=HOST-A&agent=agent-one&open=stage"
    await handleNotificationClick(clients, target)
    expect(events).toEqual(["navigate", target])
  })
  it("surfaces a focus rejection after successful navigation without trying a second privileged operation", async () => {
    const events: Array<string> = []
    const consume = windowInteractionGrant()
    const failure = new ClientOperationFailed({ operation: "focus" })
    const clients: ApprovalWorkerClients = {
      matchAll: async () => [{
        url: "https://hub.example.test/",
        focus: async () => {
          consume()
          events.push("focus:original")
        },
        navigate: async () => {
          events.push("navigate")
          return {
            focus: async () => {
              consume()
              events.push("focus:navigated")
              throw failure
            }
          }
        }
      }],
      openWindow: async () => {
        consume()
        events.push("open")
      }
    }
    await expect(
      handleNotificationClick(clients, "https://hub.example.test/connect/?host=HOST-A&agent=agent-one&open=stage")
    )
      .rejects.toBe(failure)
    expect(events).toEqual(["navigate", "focus:navigated"])
  })
})
