// @vitest-environment happy-dom

import { describe, expect, it, vi } from "@effect/vitest"
import { PullRequestId } from "@knpkv/codecommit-core/Domain.js"
import type {
  PullRequestRelayReviewResponse,
  RelayReviewStreamEvent,
  RelayReviewStreamRequest
} from "../src/server/Api.js"
// Imported once at collection: a per-test dynamic import made the first test pay the cold module load
// inside its own 5s timeout, which a loaded machine exceeded.
import { runRelayReviewStream } from "../src/client/relay-review-stream.js"

const request: RelayReviewStreamRequest = {
  revisionId: "revision-1",
  baseCommit: "a".repeat(40),
  headCommit: "b".repeat(40),
  profile: {
    id: "thorough",
    name: "Thorough review",
    kind: "review",
    provider: "codex",
    harness: "native-codex",
    model: "configured-default",
    skillIds: []
  }
}

const completedReview: PullRequestRelayReviewResponse = {
  pullRequestId: PullRequestId.make("42"),
  revisionId: "revision-1",
  baseCommit: "a".repeat(40),
  headCommit: "b".repeat(40),
  kind: "review",
  profile: request.profile,
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
    const fetchSpy = vi.spyOn(window, "fetch").mockImplementation((input) =>
      Promise.resolve(
        new Response(input === "/api/session/current" ? null : body, {
          status: input === "/api/session/current" ? 204 : 200
        })
      )
    )
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
      fetchSpy.mockRestore()
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
    const fetchSpy = vi.spyOn(window, "fetch").mockImplementation((input) =>
      Promise.resolve(
        new Response(input === "/api/session/current" ? null : body, {
          status: input === "/api/session/current" ? 204 : 200
        })
      )
    )
    try {
      await expect(runRelayReviewStream("/review", request, () => undefined)).rejects.toMatchObject({
        _tag: "RelayReviewTransportError",
        message: "Relay progress stream ended before a terminal event"
      })
    } finally {
      fetchSpy.mockRestore()
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
    const fetchSpy = vi.spyOn(window, "fetch").mockImplementation((input) =>
      Promise.resolve(
        new Response(input === "/api/session/current" ? null : body, {
          status: input === "/api/session/current" ? 204 : 200
        })
      )
    )
    try {
      await expect(runRelayReviewStream("/review", request, () => undefined)).rejects.toMatchObject({
        _tag: "RelayReviewTransportError",
        message: "Relay returned frames after the terminal event"
      })
      expect(cancel).toHaveBeenCalledOnce()
    } finally {
      fetchSpy.mockRestore()
    }
  })
})
