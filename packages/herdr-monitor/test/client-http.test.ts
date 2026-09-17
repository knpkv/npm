// @vitest-environment happy-dom
// @vitest-environment-options {"url":"http://127.0.0.1:4319/"}
import { expect, it } from "@effect/vitest"
import { Effect, Fiber } from "effect"
import { TestClock } from "effect/testing"
import { FetchHttpClient } from "effect/unstable/http"
import { readBoard } from "../src/client/read-board.js"

it.effect("non-success responses are cancelled at request scope exit", () =>
  Effect.gen(function*() {
    const observed: Array<AbortSignal> = []
    const transport: typeof fetch = (_input, init) => {
      const signal = init?.signal
      if (signal !== undefined && signal !== null) observed.push(signal)
      return Promise.resolve(new Response(new ReadableStream(), { status: 429 }))
    }
    const result = yield* readBoard("main", "synthetic-view-key").pipe(
      Effect.provideService(FetchHttpClient.Fetch, transport)
    )
    expect(result).toEqual({ status: 429, data: null })
    expect(observed).toHaveLength(1)
    expect(observed.every((signal) => signal.aborted)).toBe(true)
  }))

it.effect("decodes a valid response and applies a five-second stalled-body bound", () =>
  Effect.gen(function*() {
    const valid = {
      receivedAt: 0,
      serverAt: 0,
      stale: false,
      snapshot: { version: 1, boardId: "main", sequence: 1, sourceAt: 0, title: "Synthetic", agents: [] }
    }
    const complete: typeof fetch = () => Promise.resolve(Response.json(valid))
    const result = yield* readBoard("main", "synthetic-view-key").pipe(
      Effect.provideService(FetchHttpClient.Fetch, complete)
    )
    expect(result.data).toEqual(valid)
    const observed: Array<AbortSignal> = []
    const stalled: typeof fetch = (_input, init) => {
      const signal = init?.signal
      if (signal !== undefined && signal !== null) observed.push(signal)
      return Promise.resolve(new Response(new ReadableStream(), { status: 200 }))
    }
    const fiber = yield* readBoard("main", "synthetic-view-key").pipe(
      Effect.provideService(FetchHttpClient.Fetch, stalled),
      Effect.forkChild
    )
    yield* TestClock.adjust("5 seconds")
    const exit = yield* Fiber.await(fiber)
    expect(exit._tag).toBe("Failure")
    expect(observed).toHaveLength(1)
    expect(observed.every((signal) => signal.aborted)).toBe(true)
  }))
