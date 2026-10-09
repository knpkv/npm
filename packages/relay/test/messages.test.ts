import { describe, expect, it } from "@effect/vitest"

import { type CommittedEntry, makeMessageTracker, type SubmissionState } from "../src/messages.js"

const userEntry = (id: number, text: string): CommittedEntry => ({
  id,
  kind: "pi.user",
  model: [{ role: "user", content: text }]
})
const input = (state: Omit<SubmissionState, "type">): SubmissionState => ({ ...state, type: "input" })

describe("makeMessageTracker", () => {
  it("places a message once its entry and its record have both arrived, in either order", () => {
    const entryFirst = makeMessageTracker()
    expect(entryFirst.entry(userEntry(14, "First"))).toEqual([])
    expect(entryFirst.record(input({ id: 15, status: "placed", requestId: "req-1", entry: 14 }))).toEqual([
      { _tag: "MessagePlaced", id: "14", requestId: "req-1", text: "First" }
    ])
    const recordFirst = makeMessageTracker()
    expect(recordFirst.record(input({ id: 15, status: "placed", requestId: "req-1", entry: 14 }))).toEqual([])
    expect(recordFirst.entry(userEntry(14, "First"))).toEqual([
      { _tag: "MessagePlaced", id: "14", requestId: "req-1", text: "First" }
    ])
  })

  it("places a message whose record a coalesced batch already carries as done, and only once", () => {
    const tracker = makeMessageTracker()
    tracker.entry(userEntry(14, "First"))
    const done = input({ id: 15, status: "done", requestId: "req-1", entry: 14 })
    expect(tracker.record(done).map(({ _tag }) => _tag)).toEqual(["MessagePlaced"])
    expect(tracker.record(done)).toEqual([])
    expect(tracker.entry(userEntry(14, "First"))).toEqual([])
  })

  it("announces nothing for a message placed before the subscription", () => {
    const tracker = makeMessageTracker()
    expect(tracker.record(input({ id: 15, status: "done", requestId: "req-old", entry: 14 }))).toEqual([])
  })

  it("queues a message without an entry, and withdraws one that ends without reaching the transcript", () => {
    const tracker = makeMessageTracker()
    expect(tracker.record(input({ id: 20, status: "queued", requestId: "req-2" }))).toEqual([
      { _tag: "MessageQueued", requestId: "req-2" }
    ])
    expect(tracker.record(input({ id: 20, status: "unanswered", requestId: "req-2" }))).toEqual([
      { _tag: "MessageWithdrawn", requestId: "req-2" }
    ])
  })

  it("ignores context writes and assistant entries", () => {
    const tracker = makeMessageTracker()
    expect(tracker.record({ id: 21, type: "write", status: "done", requestId: "req-2#context-0", entry: 30 })).toEqual(
      []
    )
    expect(tracker.entry({ id: 31, kind: "pi.assistant" })).toEqual([])
  })
})
