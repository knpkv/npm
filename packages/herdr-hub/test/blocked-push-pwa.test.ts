import { describe, expect, it } from "@effect/vitest"
import { Result, Schema } from "effect"
import { BlockedPushPayload } from "../src/blocked-push-model.js"
import { blockedPushDeepLink, showBlockedNotification } from "../src/blocked-push-pwa.js"
import type { ApprovalWorkerRegistration } from "../src/pwa.js"

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
  it("keeps a bounded Voice event in the stage link while approval links keep their existing target", () => {
    expect(blockedPushDeepLink("https://hub.example.test/", { ...payload, eventId: "blocker/one?&=" })).toBe(
      "https://hub.example.test/connect/?host=HOST-A&agent=agent-one&open=stage&event=blocker%2Fone%3F%26%3D"
    )
    expect(
      blockedPushDeepLink("https://hub.example.test/", { ...payload, eventId: "blocker-one", approvalJobId: "job-one" })
    ).toBe(
      "https://hub.example.test/?tab=approvals&approvalHost=HOST-A&approvalJob=job-one"
    )
    for (const eventId of ["", "x".repeat(257)]) {
      expect(Result.isFailure(Schema.decodeUnknownResult(BlockedPushPayload)({ ...payload, eventId }))).toBe(true)
    }
    expect(Result.isSuccess(Schema.decodeUnknownResult(BlockedPushPayload)({ ...payload, eventId: "x".repeat(256) })))
      .toBe(true)
  })
  it("re-alerts when reminders and later episodes replace the same agent tag", async () => {
    const shown: Array<{ readonly tag: string; readonly renotify: boolean | undefined }> = []
    const registration: ApprovalWorkerRegistration = {
      scope: "https://hub.example.test/",
      showNotification: async (_title, options) => {
        shown.push({ tag: options.tag, renotify: options.renotify })
      }
    }
    await showBlockedNotification(registration, payload)
    await showBlockedNotification(registration, payload)
    await showBlockedNotification(registration, { ...payload, state: "needs-you" })
    expect(shown).toEqual([
      { tag: "agent-blocked:host-a:agent-one", renotify: true },
      { tag: "agent-blocked:host-a:agent-one", renotify: true },
      { tag: "agent-blocked:host-a:agent-one", renotify: true }
    ])
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
