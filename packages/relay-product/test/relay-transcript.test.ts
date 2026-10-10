import { describe, expect, it } from "@effect/vitest"

import { foldRelayConversation, initialRelayConversation, type RelayClientEvent } from "../src/relay-fold.js"
import { relayTranscriptItems } from "../src/relay-transcript.js"

const at = { seq: 0, session: "s1" }
const fold = (events: ReadonlyArray<RelayClientEvent>) => events.reduce(foldRelayConversation, initialRelayConversation)
const snapshot: RelayClientEvent = { _tag: "Snapshot", ...at, messages: [], runIds: [], queued: [] }
const placed = (id: string, requestId: string, text: string): RelayClientEvent => ({
  _tag: "MessagePlaced",
  ...at,
  id,
  requestId,
  text
})
const started = (call: string, summary: string): RelayClientEvent => ({
  _tag: "ToolStarted",
  ...at,
  call,
  capability: "get_job",
  summary,
  input: {}
})
const finished = (call: string, summary: string, ok = true): RelayClientEvent => ({
  _tag: "ToolFinished",
  ...at,
  call,
  ok,
  summary,
  cites: []
})
const readTranscript = (events: ReadonlyArray<RelayClientEvent>) =>
  relayTranscriptItems(fold(events)).map((item) =>
    item._tag === "Activity"
      ? `Activity:${item.summary}`
      : item._tag === "RunFailed"
      ? `RunFailed:${item.cause}`
      : item._tag === "You" || item._tag === "Relay" || item._tag === "Note"
      ? `${item._tag}:${item.text}`
      : item._tag
  )

describe("relayTranscriptItems", () => {
  it("shows tool work between the text before it and the reply after it", () => {
    expect(readTranscript([
      snapshot,
      placed("1", "r1", "Did job 7 pass?"),
      { _tag: "RunStarted", ...at, runIds: ["r1"] },
      { _tag: "TextDelta", ...at, seq: 2, text: "Let me look." },
      started("t1", "Reading job 7"),
      finished("t1", "Read job 7"),
      { _tag: "TextDelta", ...at, seq: 5, text: "Job 7 passed." },
      { _tag: "RunFinished", ...at, runIds: ["r1"] }
    ])).toEqual([
      "You:Did job 7 pass?",
      "Relay:Let me look.",
      "Activity:Read job 7",
      "Relay:Job 7 passed.",
      "RunFinished"
    ])
  })

  it("groups several calls into one burst and says which wait for approval", () => {
    expect(readTranscript([
      snapshot,
      placed("1", "r1", "Status?"),
      started("t1", "Reading agents"),
      started("t2", "Reading approvals"),
      { _tag: "ApprovalPending", ...at, call: "t2", approvalId: "a1" }
    ])).toEqual(["You:Status?", "Activity:2 steps, 1 waiting for approval"])
  })

  it("shows a call that finished without starting, as a blocked one does", () => {
    expect(readTranscript([snapshot, placed("1", "r1", "Run it"), finished("t9", "run shell", false)])).toEqual([
      "You:Run it",
      "Activity:run shell"
    ])
  })

  it("shows this page's queued messages and says how many wait, another page's included", () => {
    expect(readTranscript([
      snapshot,
      { _tag: "Sending", requestId: "q1", text: "And job 8?" },
      { _tag: "MessageQueued", ...at, requestId: "q1" },
      { _tag: "MessageQueued", ...at, requestId: "other-page" }
    ])).toEqual(["You:And job 8?", "Note:2 messages wait for the run in flight."])
  })

  it("names each run's end by its run, so a second failure is a new item rly announces", () => {
    const items = relayTranscriptItems(fold([
      snapshot,
      placed("1", "r1", "Hi"),
      { _tag: "RunFailed", ...at, runIds: ["r1"], cause: "SignedOut", fix: "Run codex login" },
      placed("2", "r2", "Again"),
      { _tag: "RunFailed", ...at, runIds: ["r2"], cause: "SignedOut", fix: "Run codex login" }
    ]))
    const failures = items.filter((item) => item._tag === "RunFailed").map(({ id }) => id)
    expect(new Set(failures).size).toBe(2)
  })

  it("keeps runs apart whose ids would collide if joined, and runs without ids across reconnects", () => {
    const joined = relayTranscriptItems(fold([
      snapshot,
      { _tag: "RunFailed", ...at, runIds: ["a", "b"], cause: "First", fix: "Retry" },
      { _tag: "RunFailed", ...at, runIds: ["a,b"], cause: "Second", fix: "Retry" },
      // The same end delivered twice is still one outcome.
      { _tag: "RunFailed", ...at, runIds: ["a,b"], cause: "Second", fix: "Retry" }
    ])).filter((item) => item._tag === "RunFailed")
    expect(joined).toHaveLength(2)
    // Two subscriptions each see an id-less run end at seq 4: different runs, different items.
    const first = fold([snapshot, { _tag: "Cancelled", session: "s1", seq: 4, runIds: [] }])
    const second = [snapshot, { _tag: "Cancelled", session: "s1", seq: 4, runIds: [] } satisfies RelayClientEvent]
      .reduce(foldRelayConversation, first)
    const before = relayTranscriptItems(first).filter((item) => item._tag === "RunCancelled")
    const after = relayTranscriptItems(second).filter((item) => item._tag === "RunCancelled")
    expect(before[0]?.id).not.toBe(after[0]?.id)
  })

  it("ends every run once, finished or stopped, and never at a tool boundary", () => {
    expect(readTranscript([
      snapshot,
      placed("1", "r1", "Status?"),
      { _tag: "RunStarted", ...at, runIds: ["r1"] },
      started("t1", "Reading agents"),
      finished("t1", "Read agents"),
      started("t2", "Reading approvals"),
      finished("t2", "Read approvals"),
      { _tag: "TextDelta", ...at, seq: 6, text: "All quiet." },
      { _tag: "RunFinished", ...at, runIds: ["r1"] },
      { _tag: "RunFinished", ...at, runIds: ["r1"] },
      placed("2", "r2", "And now?"),
      { _tag: "RunStarted", ...at, runIds: ["r2"] },
      { _tag: "Cancelled", ...at, runIds: ["r2"] }
    ])).toEqual([
      "You:Status?",
      "Activity:2 steps",
      "Relay:All quiet.",
      "RunFinished",
      "You:And now?",
      "RunCancelled"
    ])
  })

  it("ends with why the run failed and what to do", () => {
    expect(readTranscript([
      snapshot,
      placed("1", "r1", "Hi"),
      { _tag: "RunFailed", ...at, runIds: ["r1"], cause: "SignedOut", fix: "Run codex login" }
    ])).toEqual(["You:Hi", "RunFailed:SignedOut"])
  })
})
