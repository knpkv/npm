import { afterEach, describe, expect, it, vi } from "vitest"
import type { PushPayload } from "../src/model.js"

interface ClickEvent {
  readonly notification: { readonly close: () => void; readonly data: unknown }
  readonly waitUntil: (promise: Promise<unknown>) => void
}

class NotificationWorkerScope {
  onnotificationclick: ((event: ClickEvent) => void) | null = null
  readonly registration = { scope: "https://hub.example.test/" }
  readonly events: Array<string> = []
  private interactionAvailable = true
  outcome: "null" | "rejected" | "navigated" = "null"
  rejectFocus = false
  private consumeInteraction(): void {
    if (!this.interactionAvailable) throw new DOMException("Window interaction already consumed", "InvalidAccessError")
    this.interactionAvailable = false
  }
  readonly navigated = {
    focus: async () => {
      this.consumeInteraction()
      this.events.push("focus:navigated")
      if (this.rejectFocus) throw new DOMException("Window inactive", "InvalidStateError")
    }
  }
  readonly client = {
    url: "https://hub.example.test/",
    focus: async () => {
      this.consumeInteraction()
      this.events.push("focus:original")
    },
    navigate: async () => {
      this.events.push("navigate")
      if (this.outcome === "rejected") throw new DOMException("Navigation rejected", "InvalidStateError")
      return this.outcome === "null" ? null : this.navigated
    }
  }
  controlled = true
  readonly clients = {
    matchAll: async (options: { readonly includeUncontrolled?: boolean; readonly type?: string }) => {
      this.events.push(`match:${String(options.includeUncontrolled)}:${String(options.type)}`)
      return this.controlled || options.includeUncontrolled === true ? [this.client] : []
    },
    openWindow: async (url: string) => {
      this.consumeInteraction()
      this.events.push(url)
    }
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

const click = async (scope: NotificationWorkerScope, data: PushPayload) => {
  vi.stubGlobal("ServiceWorkerGlobalScope", NotificationWorkerScope)
  vi.stubGlobal("self", scope)
  await import("../src/approval-service-worker.js")
  const pending: Array<Promise<unknown>> = []
  scope.onnotificationclick?.({
    notification: {
      close: () => {
        scope.events.push("close")
      },
      data
    },
    waitUntil: (promise) => {
      pending.push(promise)
    }
  })
  expect(pending).toHaveLength(1)
  return Promise.all(pending)
}
const notifications: ReadonlyArray<{ readonly name: string; readonly target: string; readonly data: PushPayload }> = [
  {
    name: "blocked",
    target: "https://hub.example.test/connect/?host=HOST-A&agent=agent-one&open=stage",
    data: {
      kind: "agent-blocked",
      host: "HOST-A",
      agentId: "agent-one",
      agentName: "worker",
      state: "blocked",
      firstLine: "worker is blocked",
      approvalJobId: null
    }
  },
  {
    name: "approval",
    target: "https://hub.example.test/?tab=approvals&approvalHost=HOST-A&approvalJob=job-one",
    data: {
      host: "HOST-A",
      jobId: "job-one",
      pendingCount: 1
    }
  }
]
const missedOutcomes: ReadonlyArray<"null" | "rejected"> = ["null", "rejected"]
describe("notification click worker boundary", () => {
  for (const notification of notifications) {
    it.each(missedOutcomes)(
      `opens ${notification.name} after %s navigation using its unspent grant`,
      async (outcome) => {
        const scope = new NotificationWorkerScope()
        scope.outcome = outcome
        await click(scope, notification.data)
        expect(scope.events).toEqual(["close", "match:false:window", "navigate", notification.target])
      }
    )
    it(`opens ${notification.name} without reusing an uncontrolled window`, async () => {
      const scope = new NotificationWorkerScope()
      scope.controlled = false
      await click(scope, notification.data)
      expect(scope.events).toEqual(["close", "match:false:window", notification.target])
    })
    it(`focuses the returned ${notification.name} window after successful navigation`, async () => {
      const scope = new NotificationWorkerScope()
      scope.outcome = "navigated"
      await click(scope, notification.data)
      expect(scope.events).toEqual(["close", "match:false:window", "navigate", "focus:navigated"])
    })
    it(`surfaces ${notification.name} focus failure without attempting a second window interaction`, async () => {
      const scope = new NotificationWorkerScope()
      scope.outcome = "navigated"
      scope.rejectFocus = true
      await expect(click(scope, notification.data)).rejects.toMatchObject({ _tag: "WorkerNotificationError" })
      expect(scope.events).toEqual(["close", "match:false:window", "navigate", "focus:navigated"])
    })
  }
})
