import { describe, expect, it } from "@effect/vitest"
import type { BlockedPushPayload } from "../src/blocked-push-model.js"
import { blockedPushDeepLink, showBlockedNotification } from "../src/blocked-push-pwa.js"

const payload: BlockedPushPayload = {
  kind: "agent-blocked",
  host: "HOST-A",
  agentId: "agent-one",
  agentName: "worker",
  state: "blocked",
  firstLine: "Please review the change",
  approvalJobId: null
}

describe("blocked push presentation", () => {
  it("opens the agent stage, or the existing approval deep link when a job is known", () => {
    expect(blockedPushDeepLink("https://hub.example.test/", payload)).toBe(
      "https://hub.example.test/connect/?host=HOST-A&agent=agent-one&open=stage"
    )
    expect(blockedPushDeepLink("https://hub.example.test/", { ...payload, approvalJobId: "job-one" })).toBe(
      "https://hub.example.test/?tab=approvals&approvalHost=HOST-A&approvalJob=job-one"
    )
  })
  it("uses a per-agent replacement tag and only name, state and the reported first line", async () => {
    const shown: Array<{ readonly title: string; readonly body: string; readonly tag: string }> = []
    await showBlockedNotification({
      scope: "https://hub.example.test/",
      showNotification: async (title, options) => {
        shown.push({ title, body: options.body, tag: options.tag })
      }
    }, payload)
    expect(shown).toEqual([{
      title: "worker needs you",
      body: "worker is blocked. Please review the change",
      tag: "agent-blocked:host-a:agent-one"
    }])
  })
})
