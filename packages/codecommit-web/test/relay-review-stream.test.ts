// @vitest-environment happy-dom

import { describe, expect, it } from "@effect/vitest"
import { runRelayReviewStream } from "../src/client/relay-review-stream.js"
import type { RelayReviewStreamEvent, RelayReviewStreamRequest } from "../src/server/Api.js"

const request: RelayReviewStreamRequest = {
  revisionId: "revision-1",
  baseCommit: "a".repeat(40),
  headCommit: "b".repeat(40),
  kind: "review",
  skillIds: []
}

describe("Relay review NDJSON transport", () => {
  it("emits progress before a split terminal frame completes", async () => {
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        streamController = controller
      }
    })
    const originalFetch = window.fetch
    window.fetch = () => Promise.resolve(new Response(body, { status: 200 }))
    const events: Array<RelayReviewStreamEvent> = []
    const firstEvent = Promise.withResolvers<void>()
    const encoder = new TextEncoder()
    try {
      const running = runRelayReviewStream("/review", request, (event) => {
        events.push(event)
        firstEvent.resolve()
      })
      streamController?.enqueue(encoder.encode(
        `${JSON.stringify({ type: "progress", phase: "agent", message: "Relay is reviewing" })}\n{"type":"error"`
      ))
      await firstEvent.promise
      expect(events).toEqual([{ type: "progress", phase: "agent", message: "Relay is reviewing" }])
      streamController?.enqueue(encoder.encode(",\"message\":\"stopped\"}\n"))
      streamController?.close()
      await running
      expect(events[1]).toEqual({ type: "error", message: "stopped" })
    } finally {
      window.fetch = originalFetch
    }
  })
})
