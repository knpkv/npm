// @vitest-environment happy-dom

import { describe, expect, it } from "@effect/vitest"
import { runRelayReviewStream } from "../src/client/relay-review-stream.js"
import type {
  PullRequestRelayReviewResponse,
  RelayReviewStreamEvent,
  RelayReviewStreamRequest
} from "../src/server/Api.js"

const request: RelayReviewStreamRequest = {
  revisionId: "revision-1",
  baseCommit: "a".repeat(40),
  headCommit: "b".repeat(40),
  kind: "review",
  skillIds: []
}

const completedReview: PullRequestRelayReviewResponse = {
  pullRequestId: "42",
  revisionId: "revision-1",
  baseCommit: "a".repeat(40),
  headCommit: "b".repeat(40),
  kind: "review",
  result: { findings: [], verdict: "No findings." }
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
        `${JSON.stringify({ type: "progress", phase: "agent", message: "Relay is reviewing" })}\n{"type":"complete"`
      ))
      await firstEvent.promise
      expect(events).toEqual([{ type: "progress", phase: "agent", message: "Relay is reviewing" }])
      streamController?.enqueue(encoder.encode(",\"review\":"))
      streamController?.enqueue(encoder.encode(`${JSON.stringify(completedReview)}}\n`))
      streamController?.close()
      await running
      expect(events[1]).toEqual({ type: "complete", review: completedReview })
    } finally {
      window.fetch = originalFetch
    }
  })

  it("rejects a clean EOF before a terminal event", async () => {
    const encoder = new TextEncoder()
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        controller.enqueue(encoder.encode(
          `${JSON.stringify({ type: "progress", phase: "agent", message: "Relay is reviewing" })}\n`
        ))
        controller.close()
      }
    })
    const originalFetch = window.fetch
    window.fetch = () => Promise.resolve(new Response(body, { status: 200 }))
    try {
      await expect(runRelayReviewStream("/review", request, () => undefined)).rejects.toMatchObject({
        _tag: "RelayReviewTransportError",
        message: "Relay progress stream ended before a terminal event"
      })
    } finally {
      window.fetch = originalFetch
    }
  })

  it("rejects duplicate terminal frames", async () => {
    const encoder = new TextEncoder()
    const terminal = `${JSON.stringify({ type: "error", message: "stopped" })}\n`
    const cancel = vi.fn()
    const body = new ReadableStream<Uint8Array>({
      cancel,
      start: (controller) => {
        controller.enqueue(encoder.encode(terminal + terminal))
      }
    })
    const originalFetch = window.fetch
    window.fetch = () => Promise.resolve(new Response(body, { status: 200 }))
    try {
      await expect(runRelayReviewStream("/review", request, () => undefined)).rejects.toMatchObject({
        _tag: "RelayReviewTransportError",
        message: "Relay returned frames after the terminal event"
      })
      expect(cancel).toHaveBeenCalledOnce()
    } finally {
      window.fetch = originalFetch
    }
  })
})
