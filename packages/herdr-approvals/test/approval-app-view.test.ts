import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { chatModeForShortcut, connectWorkerHref, submitChatDraft } from "../src/approval-app-view.js"

describe("coordinator chat draft", () => {
  it("links an exact remote worker to its remote Connect room", () => {
    expect(connectWorkerHref({
      agentId: "agent-remote-worker",
      host: "PI",
      name: "Remote worker",
      paneId: "w2:p3",
      relationship: {
        parentAgentId: "agent-coordinator",
        relation: "delegated"
      }
    })).toBe("/connect/?agent=agent-remote-worker&host=PI")
  })

  it.effect("retains the draft and exposes a failed submission", () =>
    Effect.gen(function*() {
      expect(
        yield* Effect.promise(() => submitChatDraft("ask", "keep this", () => Promise.resolve(false)))
      ).toEqual({
        error: "Message not sent. Try again.",
        message: "keep this"
      })
    }))

  it.effect("clears the draft after a successful submission", () =>
    Effect.gen(function*() {
      expect(
        yield* Effect.promise(() => submitChatDraft("work", "ship this", () => Promise.resolve(true)))
      ).toEqual({ error: null, message: "" })
    }))

  it("maps deliberate coordinator chat shortcuts", () => {
    expect(chatModeForShortcut({ key: "Enter", modified: true, shift: false })).toBe("ask")
    expect(chatModeForShortcut({ key: "Enter", modified: true, shift: true })).toBe("work")
    expect(chatModeForShortcut({ key: "Enter", modified: false, shift: false })).toBeNull()
  })
})
