import { describe, expect, it } from "@effect/vitest"
import type { JobRecord } from "@knpkv/herdr-fleet/model"
import { Effect, Result } from "effect"
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

const approvalRecord = (id: string): JobRecord => ({
  actor: "andrey@example.com",
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
        chatEnabled: false,
        pushEnabled: true
      },
      approvalsEnabled: true,
      chat: null,
      directory: null,
      historyNextCursor: null,
      host: "SER8",
      observedAt: 2,
      pendingApprovals: { failures: [], local: [], nextCursors: [], remote: [] },
      records: [],
      status: {
        applyConfigured: false,
        branch: "main",
        dirty: false,
        herdr: { agents: [], available: true, error: null },
        host: "SER8",
        repository: "/repo",
        revision: "abc123"
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
      })
    ).toBeNull()
    expect(
      dashboardPendingBadgeCount({
        failures: [],
        local: Array.from({ length: 9 }, (_, index) => approvalRecord(`job-${String(index)}`)),
        nextCursors: [],
        remote: []
      })
    ).toBe(9)
  })

  it.effect("trusts only header-free loopback requests", () =>
    Effect.gen(function*() {
      expect(
        yield* authorize(
          { login: undefined, remoteAddress: "127.0.0.1" },
          ["andrey@example.com"],
          true
        )
      ).toBe("local")
      const forwarded = yield* Effect.result(
        authorize(
          { login: "andrey@example.com", remoteAddress: undefined },
          ["andrey@example.com"],
          false
        )
      )
      expect(Result.isFailure(forwarded)).toBe(true)
      const spoofed = yield* Effect.result(
        authorize(
          { login: "andrey@example.com", remoteAddress: "100.64.0.2" },
          ["andrey@example.com"],
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

  it("navigates and focuses an existing canonical approval window", async () => {
    const focused: Array<string> = []
    const navigated: Array<string> = []
    const opened: Array<string> = []
    const clients: ApprovalWorkerClients = {
      matchAll: () =>
        Promise.resolve([
          {
            focus: () => {
              focused.push("yes")
              return Promise.resolve()
            },
            navigate: (url) => {
              navigated.push(url)
              return Promise.resolve()
            },
            url: "https://ser8.example.ts.net/?tab=connect"
          }
        ]),
      openWindow: (url) => {
        opened.push(url)
        return Promise.resolve()
      }
    }
    const target = "https://ser8.example.ts.net/?tab=approvals&approvalHost=PI&approvalJob=job-7"
    await handleNotificationClick(clients, target)
    expect(navigated).toEqual([target])
    expect(focused).toEqual(["yes"])
    expect(opened).toEqual([])
  })

  it("opens the individual approval deep link when the app is closed", async () => {
    const opened: Array<string> = []
    const clients: ApprovalWorkerClients = {
      matchAll: () => Promise.resolve([]),
      openWindow: (url) => {
        opened.push(url)
        return Promise.resolve()
      }
    }
    const target = "https://ser8.example.ts.net/?tab=approvals&approvalHost=PI&approvalJob=job-7"
    await handleNotificationClick(clients, target)
    expect(opened).toEqual([target])
  })
})
