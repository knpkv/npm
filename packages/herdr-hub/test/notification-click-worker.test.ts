import { afterEach, describe, expect, it, vi } from "vitest"

interface ClickEvent {
  readonly notification: { readonly close: () => void; readonly data: unknown }
  readonly waitUntil: (promise: Promise<unknown>) => void
}

class NotificationWorkerScope {
  onnotificationclick: ((event: ClickEvent) => void) | null = null
  readonly registration = { scope: "https://hub.example.test/" }
  readonly events: Array<string> = []
  readonly client = {
    url: "https://hub.example.test/",
    focus: async () => {
      this.events.push("focus")
    },
    navigate: async () => {
      this.events.push("navigate")
      return null
    }
  }
  controlled = true
  readonly clients = {
    matchAll: async (options: { readonly includeUncontrolled?: boolean; readonly type?: string }) => {
      this.events.push(`match:${String(options.includeUncontrolled)}:${String(options.type)}`)
      return this.controlled || options.includeUncontrolled === true ? [this.client] : []
    },
    openWindow: async (url: string) => {
      this.events.push(url)
    }
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe("notification click worker boundary", () => {
  it.each([true, false])("opens the stage after a missed client navigation, controlled=%s", async (controlled) => {
    const scope = new NotificationWorkerScope()
    scope.controlled = controlled
    vi.stubGlobal("ServiceWorkerGlobalScope", NotificationWorkerScope)
    vi.stubGlobal("self", scope)
    await import("../src/approval-service-worker.js")
    const pending: Array<Promise<unknown>> = []
    scope.onnotificationclick?.({
      notification: {
        close: () => {
          scope.events.push("close")
        },
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
      waitUntil: (promise) => {
        pending.push(promise)
      }
    })
    expect(pending).toHaveLength(1)
    await Promise.all(pending)
    expect(scope.events).toEqual([
      "close",
      "match:false:window",
      ...(controlled ? ["focus", "navigate"] : []),
      "https://hub.example.test/connect/?host=HOST-A&agent=agent-one&open=stage"
    ])
  })
})
