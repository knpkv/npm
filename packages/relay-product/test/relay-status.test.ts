import { describe, expect, it } from "@effect/vitest"

import {
  foldRelayConversation,
  initialRelayConversation,
  type RelayClientEvent,
  type RelayConfirmationCard,
  type RelayConversationState
} from "../src/relay-fold.js"
import {
  nextSeenReplies,
  RELAY_STATUS_LINE_MAX,
  type RelaySeenReplies,
  relaySeenRepliesUnknown,
  relayStatusOf
} from "../src/relay-status.js"

const fold = (events: ReadonlyArray<RelayClientEvent>, from: RelayConversationState = initialRelayConversation) =>
  events.reduce(foldRelayConversation, from)

const at = { seq: 0, session: "s1" }
const live: RelayConversationState = fold([{ _tag: "Snapshot", ...at, messages: [], runIds: [], queued: [] }])
const closed = { panelOpen: false, seen: relaySeenRepliesUnknown }
const action: RelayConfirmationCard["action"] = {
  verb: "post_comment",
  target: { product: "codecommit", kind: "pull-request", id: "pr-1" },
  args: { content: "Looks good" }
}
const replied = (state: RelayConversationState, runId: string, text: string): RelayConversationState =>
  fold([
    { _tag: "RunStarted", ...at, runIds: [runId] },
    { _tag: "TextDelta", ...at, text },
    { _tag: "RunFinished", ...at, runIds: [runId] }
  ], state)

describe("relayStatusOf", () => {
  it("names each phase in fixed words and shows the mark that goes with it", () => {
    const running = fold([{ _tag: "RunStarted", ...at, runIds: ["r1"] }], live)
    const reading = fold([{
      _tag: "ToolStarted",
      ...at,
      call: "t1",
      capability: "read_files",
      summary: "Reading 12 files",
      input: {}
    }], running)
    const answering = fold([{ _tag: "TextDelta", ...at, text: "The hunk" }], running)
    const waiting = fold([{ _tag: "ConfirmationRequired", ...at, call: "c1", action, reversible: false }], running)
    const failed = fold([{ _tag: "RunFailed", ...at, runIds: ["r1"], cause: "x", fix: "y" }], running)
    const view = (state: RelayConversationState) => relayStatusOf(state, closed)
    expect(view(live)).toEqual({ activity: "idle", line: null, words: null })
    expect(view(running)).toEqual({ activity: "working", line: null, words: "Reading…" })
    expect(view(reading)).toEqual({ activity: "working", line: "Reading 12 files", words: "Reading…" })
    expect(view(answering)).toEqual({ activity: "working", line: null, words: "Answering…" })
    expect(view(waiting)).toEqual({ activity: "attention", line: null, words: "Relay needs you" })
    expect(view({ ...live, outbox: [{ requestId: "q1", text: "hello" }] }).words).toBe("Sending…")
    expect(view(failed)).toEqual({ activity: "idle", line: null, words: "Relay hit an error" })
    const signedOut = fold([{
      _tag: "Backend",
      status: { _tag: "Unavailable", backend: "codex-cli", label: "Codex", cause: "SignedOut", fix: "codex login" }
    }], failed)
    expect(view(signedOut).words).toBe("Sign in to Codex")
  })

  // Never stuck working: a dropped or refused stream says it doesn't know rather than showing the last state.
  it("goes still and says so when the stream is down", () => {
    const running = fold([{ _tag: "RunStarted", ...at, runIds: ["r1"] }], live)
    const down: ReadonlyArray<RelayClientEvent> = [{ _tag: "Disconnected" }, { _tag: "StreamFailed" }]
    for (const event of down) {
      expect(relayStatusOf(fold([event], running), closed)).toEqual({
        activity: "idle",
        line: null,
        words: "Relay status unknown"
      })
    }
    expect(relayStatusOf(fold([{ _tag: "Unauthorized" }], running), closed).words).toBe("Sign in to use Relay")
  })

  it("caps a long tool summary", () => {
    const summary = `Reading ${"a".repeat(200)}`
    const state = fold([
      { _tag: "RunStarted", ...at, runIds: ["r1"] },
      { _tag: "ToolStarted", ...at, call: "t1", capability: "read_files", summary, input: {} }
    ], live)
    const line = relayStatusOf(state, closed).line ?? ""
    expect(line.length).toBe(RELAY_STATUS_LINE_MAX)
    expect(line.endsWith("…")).toBe(true)
  })

  // The status line is fixed words plus a tool's server-built summary; nothing the model or a person wrote.
  it("never shows reply, message, failure or action text", () => {
    const secret = "SECRET-7f3a"
    const base = fold([
      {
        _tag: "Snapshot",
        ...at,
        messages: [{ id: "1", role: "user", text: `${secret} user` }, {
          id: "2",
          role: "relay",
          text: `${secret} reply`
        }],
        runIds: [],
        queued: []
      }
    ])
    const states: ReadonlyArray<RelayConversationState> = [
      fold([{ _tag: "RunStarted", ...at, runIds: ["r1"] }, { _tag: "TextDelta", ...at, text: secret }], base),
      fold([
        { _tag: "RunStarted", ...at, runIds: ["r1"] },
        {
          _tag: "ConfirmationRequired",
          ...at,
          call: "c1",
          action: { ...action, args: { content: secret } },
          reversible: false
        }
      ], base),
      fold([
        { _tag: "RunStarted", ...at, runIds: ["r1"] },
        { _tag: "RunFailed", ...at, runIds: ["r1"], cause: secret, fix: secret }
      ], base),
      { ...base, outbox: [{ requestId: "q1", text: secret }] },
      { ...base, queued: [{ requestId: "q2", text: secret }] },
      fold([{ _tag: "RunStarted", ...at, runIds: ["r1"] }, { _tag: "TextDelta", ...at, text: secret }, {
        _tag: "RunFinished",
        ...at,
        runIds: ["r1"]
      }], base)
    ]
    const seen: RelaySeenReplies = { _tag: "Seen", count: 0 }
    for (const state of states) {
      for (const panelOpen of [false, true]) {
        expect(JSON.stringify(relayStatusOf(state, { panelOpen, seen }))).not.toContain(secret)
      }
    }
  })
})

describe("unread", () => {
  const status = (state: RelayConversationState, panelOpen: boolean, seen: RelaySeenReplies) =>
    relayStatusOf(state, { panelOpen, seen: nextSeenReplies(seen, state, panelOpen) })

  it("is a reply that finished while the panel was closed, until the panel opens", () => {
    const seen = nextSeenReplies(relaySeenRepliesUnknown, live, false)
    const after = replied(live, "r1", "Done.")
    expect(status(after, false, seen)).toEqual({ activity: "unread", line: null, words: "Relay replied" })
    const opened = nextSeenReplies(seen, after, true)
    expect(status(after, true, seen).activity).toBe("idle")
    expect(status(after, false, opened).activity).toBe("idle")
  })

  it("never counts history loaded on mount, or a reply finished while the panel was open", () => {
    const history = replied(replied(live, "r1", "One."), "r2", "Two.")
    expect(status(history, false, relaySeenRepliesUnknown).activity).toBe("idle")
    const openSeen = nextSeenReplies(
      nextSeenReplies(relaySeenRepliesUnknown, live, true),
      replied(live, "r1", "x"),
      true
    )
    expect(status(replied(live, "r1", "x"), false, openSeen).activity).toBe("idle")
  })

  // A reconnect's Snapshot names the same replies with server ids; counting them keeps them read.
  it("does not come back after a reconnect restores replies the reader saw", () => {
    const after = replied(live, "r1", "Done.")
    const read = nextSeenReplies(relaySeenRepliesUnknown, after, true)
    const restored = fold([
      { _tag: "Disconnected" },
      { _tag: "Reconnecting" },
      { _tag: "Snapshot", ...at, messages: [{ id: "srv-9", role: "relay", text: "Done." }], runIds: [], queued: [] }
    ], after)
    expect(status(restored, false, read).activity).toBe("idle")
  })

  it("keeps the same seen value when nothing new finished, so React state settles", () => {
    const seen = nextSeenReplies(relaySeenRepliesUnknown, live, true)
    expect(nextSeenReplies(seen, live, true)).toBe(seen)
    expect(nextSeenReplies(seen, live, false)).toBe(seen)
  })
})
