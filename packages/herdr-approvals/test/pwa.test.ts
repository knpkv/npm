import { describe, expect, it } from "@effect/vitest"
import { Effect, Result } from "effect"
import { authorize } from "../src/auth.js"
import {
  approvalDeepLink,
  type ApprovalWorkerClients,
  type ApprovalWorkerRegistration,
  handleNotificationClick,
  readApprovalDeepLink,
  showApprovalNotification
} from "../src/pwa.js"

describe("approval PWA", () => {
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
