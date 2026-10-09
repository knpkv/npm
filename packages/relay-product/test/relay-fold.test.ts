import { describe, expect, it } from "@effect/vitest"

import {
  foldRelayConversation,
  initialRelayConversation,
  type RelayClientEvent,
  type RelayConfirmationCard,
  type RelayConversationState
} from "../src/relay-fold.js"

const fold = (events: ReadonlyArray<RelayClientEvent>, from: RelayConversationState = initialRelayConversation) =>
  events.reduce(foldRelayConversation, from)

const at = { seq: 0, session: "s1" }
const snapshot = (
  messages: ReadonlyArray<{ readonly id: string; readonly role: "user" | "relay"; readonly text: string }>,
  runIds: ReadonlyArray<string> = [],
  queued: ReadonlyArray<string> = []
): RelayClientEvent => ({ _tag: "Snapshot", ...at, messages, runIds, queued })
const placed = (id: string, requestId: string, text: string): RelayClientEvent => ({
  _tag: "MessagePlaced",
  ...at,
  id,
  requestId,
  text
})
const action: RelayConfirmationCard["action"] = {
  verb: "post_comment",
  target: { product: "codecommit", kind: "pull-request", id: "pr-1" },
  args: { content: "Looks good" }
}

describe("foldRelayConversation", () => {
  it("replaces the transcript on a Snapshot rather than merging into it", () => {
    const before = fold([snapshot([{ id: "1", role: "user", text: "old" }]), placed("3", "r9", "placed")])
    const after = foldRelayConversation(before, snapshot([{ id: "2", role: "relay", text: "new" }]))
    expect(after.messages.map(({ id }) => id)).toEqual(["2"])
    expect(after.connection).toBe("live")
  })

  it("streams a reply into one message and ends it when the run finishes", () => {
    const state = fold([
      snapshot([]),
      { _tag: "RunStarted", ...at, runIds: ["r1"] },
      { _tag: "TextDelta", ...at, text: "Hel" },
      { _tag: "TextDelta", ...at, text: "lo" }
    ])
    expect(state.messages).toEqual([{ id: "reply:s1:0", role: "relay", streaming: true, text: "Hello" }])
    expect(state.runIds).toEqual(["r1"])
    const done = foldRelayConversation(state, { _tag: "RunFinished", ...at, runIds: ["r1"] })
    expect(done.messages[0]?.streaming).toBe(false)
    expect(done.runIds).toEqual([])
  })

  it("shows a message only when the stream queues or places it, with the text this page sent", () => {
    const sending: RelayClientEvent = { _tag: "Sending", requestId: "r1", text: "What changed?" }
    const sent = fold([snapshot([]), sending])
    expect(sent.messages).toEqual([])
    expect(sent.queued).toEqual([])
    const queued = foldRelayConversation(sent, { _tag: "MessageQueued", ...at, requestId: "r1" })
    expect(queued.queued).toEqual([{ requestId: "r1", text: "What changed?" }])
    const done = fold([placed("7", "r1", "What changed?"), placed("7", "r1", "What changed?")], queued)
    expect(done.messages).toEqual([{ id: "7", role: "user", streaming: false, text: "What changed?" }])
    expect(done.queued).toEqual([])
    expect(done.outbox).toEqual([])
  })

  it("keeps a send a Snapshot taken before its commit can't show, until the stream reports it", () => {
    const state = fold([
      snapshot([]),
      { _tag: "Sending", requestId: "r1", text: "Status?" },
      // Taken before the server committed r1: neither queued nor in the transcript.
      snapshot([]),
      placed("4", "r1", "Status?")
    ])
    expect(state.messages.map(({ id, role }) => `${role}:${id}`)).toEqual(["user:4"])
  })

  it("names a queued message's text from this page's send, whichever arrives first", () => {
    const fromSnapshot = fold([
      snapshot([], ["r0"], ["r1", "other-page"]),
      { _tag: "Sending", requestId: "r1", text: "Mine" }
    ])
    expect(fromSnapshot.queued).toEqual([{ requestId: "r1", text: "Mine" }, { requestId: "other-page", text: null }])
    const sentFirst = fold([
      snapshot([]),
      { _tag: "Sending", requestId: "r1", text: "Mine" },
      snapshot([], ["r0"], ["r1"])
    ])
    expect(sentFirst.queued).toEqual([{ requestId: "r1", text: "Mine" }])
  })

  it("withdraws one queued message and leaves the others and the reply streaming", () => {
    const state = fold([
      snapshot([], ["r0"], ["r1", "r2"]),
      { _tag: "TextDelta", ...at, seq: 3, text: "Working" },
      { _tag: "MessageWithdrawn", ...at, requestId: "r1" }
    ])
    expect(state.queued.map(({ requestId }) => requestId)).toEqual(["r2"])
    expect(state.messages).toEqual([{ id: "reply:s1:3", role: "relay", streaming: true, text: "Working" }])
  })

  it("keeps one reply per answer, with each placed message before the reply that follows it", () => {
    const state = fold([
      snapshot([]),
      placed("1", "r1", "First"),
      { _tag: "RunStarted", ...at, runIds: ["r1"] },
      { _tag: "TextDelta", ...at, seq: 2, text: "One" },
      { _tag: "TextDelta", ...at, seq: 3, text: " answer" },
      // A follow-up placed while the run continues: its answer is a new reply.
      placed("5", "r2", "Second"),
      { _tag: "TextDelta", ...at, seq: 6, text: "Two" }
    ])
    expect(state.messages.map(({ role, text }) => `${role}:${text}`)).toEqual([
      "user:First",
      "relay:One answer",
      "user:Second",
      "relay:Two"
    ])
  })

  it("splits a reply at a tool call into the rows a reconnect's Snapshot shows", () => {
    const live = fold([
      snapshot([]),
      placed("1", "r1", "What changed?"),
      { _tag: "RunStarted", ...at, runIds: ["r1"] },
      { _tag: "TextDelta", ...at, seq: 2, text: "Let me look." },
      { _tag: "ToolStarted", ...at, call: "t1", capability: "get_job", summary: "Reading job 7", input: {} },
      { _tag: "ToolFinished", ...at, call: "t1", ok: true, summary: "Read job 7", cites: [] },
      { _tag: "TextDelta", ...at, seq: 5, text: "Job 7 passed." },
      { _tag: "RunFinished", ...at, runIds: ["r1"] }
    ])
    const reconnected = foldRelayConversation(
      live,
      snapshot([
        { id: "1", role: "user", text: "What changed?" },
        { id: "2", role: "relay", text: "Let me look." },
        { id: "4", role: "relay", text: "Job 7 passed." }
      ])
    )
    const rows = (state: RelayConversationState) => state.messages.map(({ role, text }) => `${role}:${text}`)
    expect(rows(live)).toEqual(rows(reconnected))
  })

  it("splits a reply at a tool that finishes without starting, as a blocked call does", () => {
    const live = fold([
      snapshot([]),
      { _tag: "RunStarted", ...at, runIds: ["r1"] },
      { _tag: "TextDelta", ...at, seq: 2, text: "Let me try." },
      { _tag: "ToolFinished", ...at, call: "t9", ok: false, summary: "run shell", cites: [] },
      { _tag: "TextDelta", ...at, seq: 4, text: "It is unavailable." }
    ])
    expect(live.messages.map(({ text }) => text)).toEqual(["Let me try.", "It is unavailable."])
  })

  it("leaves out a turn that only called tools", () => {
    const state = fold([snapshot([{ id: "1", role: "user", text: "Hi" }, { id: "2", role: "relay", text: "" }])])
    expect(state.messages.map(({ id }) => id)).toEqual(["1"])
  })

  it("turns a card to past tense only on the server's resolution", () => {
    const required: RelayClientEvent = { _tag: "ConfirmationRequired", ...at, call: "c1", action, reversible: false }
    const pending = fold([snapshot([]), required])
    expect(pending.confirmations.map(({ decision }) => decision)).toEqual(["pending"])
    const resolved = foldRelayConversation(pending, {
      _tag: "ConfirmationResolved",
      ...at,
      call: "c1",
      decision: "expired"
    })
    expect(resolved.confirmations.map(({ decision }) => decision)).toEqual(["expired"])
  })

  it("brings back only the cards still open after a reconnect", () => {
    const required: RelayClientEvent = { _tag: "ConfirmationRequired", ...at, call: "c1", action, reversible: true }
    const decidedWhileAway = fold([
      snapshot([]),
      required,
      { _tag: "Disconnected" },
      // The reconnect's Snapshot is followed by the cards still open: none.
      snapshot([])
    ])
    expect(decidedWhileAway.confirmations).toEqual([])
    const stillOpen = foldRelayConversation(decidedWhileAway, required)
    expect(stillOpen.confirmations.map(({ call }) => call)).toEqual(["c1"])
  })

  it("keeps a tool row through approval and finishing, with its receipt", () => {
    const state = fold([
      snapshot([]),
      { _tag: "ToolStarted", ...at, call: "t1", capability: "post_comment", summary: "Posting", input: {} },
      { _tag: "ApprovalPending", ...at, call: "t1", approvalId: "a1" },
      {
        _tag: "ToolFinished",
        ...at,
        call: "t1",
        ok: true,
        summary: "Posted",
        cites: [],
        receipt: { summary: "Comment posted", providerId: "op-1" }
      }
    ])
    expect(state.tools).toEqual([{
      call: "t1",
      capability: "post_comment",
      receipt: { providerId: "op-1", summary: "Comment posted" },
      state: "ok",
      summary: "Posted"
    }])
  })

  it("keeps why a run failed until the next one starts", () => {
    const failed = fold([
      snapshot([], ["r1"]),
      { _tag: "RunFailed", ...at, runIds: ["r1"], cause: "SignedOut", fix: "Run codex login" }
    ])
    expect(failed.failure).toEqual({ cause: "SignedOut", fix: "Run codex login" })
    expect(failed.runIds).toEqual([])
    expect(foldRelayConversation(failed, { _tag: "RunStarted", ...at, runIds: ["r2"] }).failure).toBeNull()
  })

  it("never reads as working while the stream is down", () => {
    const working = fold([snapshot([], ["r1"]), { _tag: "TextDelta", ...at, text: "…" }])
    const ends: ReadonlyArray<"Disconnected" | "StreamFailed" | "Unauthorized"> = [
      "Disconnected",
      "Unauthorized",
      "StreamFailed"
    ]
    for (const tag of ends) {
      const down = foldRelayConversation(working, { _tag: tag })
      expect(down.runIds).toEqual([])
      expect(down.messages.every(({ streaming }) => !streaming)).toBe(true)
    }
    expect(foldRelayConversation(working, { _tag: "Unauthorized" }).connection).toBe("unauthorized")
    expect(foldRelayConversation(working, { _tag: "StreamFailed" }).connection).toBe("failed")
  })
})
