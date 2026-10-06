/** One dropped connection must not discard a long read; a server's own answer must never be re-asked. */
import { describe, expect, it } from "@effect/vitest"
import { Effect, Exit, Fiber, Ref } from "effect"
import * as HttpClientError from "effect/http/HttpClientError"
import * as HttpClientRequest from "effect/http/HttpClientRequest"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import * as TestClock from "effect/testing/TestClock"
import { retryTransport } from "../src/services/internal/retryTransport.js"

const request = HttpClientRequest.get("https://jira.example/rest/api/3/issue/PROJ-1/worklog")
const dropped = new HttpClientError.HttpClientError({
  reason: new HttpClientError.TransportError({ request, description: "Connection reset" })
})

/** A read that fails `failures` times with `error`, then succeeds; counts every attempt. */
const flaky = (failures: number, error: HttpClientError.HttpClientError) =>
  Effect.gen(function*() {
    const attempts = yield* Ref.make(0)
    const read = Ref.updateAndGet(attempts, (n) => n + 1).pipe(
      Effect.flatMap((n) => n <= failures ? Effect.fail(error) : Effect.succeed("page"))
    )
    return { attempts, read }
  })

describe("retryTransport", () => {
  it.effect("survives two dropped connections", () =>
    Effect.gen(function*() {
      const { attempts, read } = yield* flaky(2, dropped)
      const fiber = yield* Effect.forkChild(retryTransport(read))
      yield* TestClock.adjust("2 seconds")
      expect(yield* Fiber.join(fiber)).toBe("page")
      expect(yield* Ref.get(attempts)).toBe(3)
    }))

  it.effect("gives up after the third dropped connection", () =>
    Effect.gen(function*() {
      const { attempts, read } = yield* flaky(3, dropped)
      const fiber = yield* Effect.forkChild(retryTransport(read))
      yield* TestClock.adjust("2 seconds")
      expect(Exit.isFailure(yield* Fiber.await(fiber))).toBe(true)
      expect(yield* Ref.get(attempts)).toBe(3)
    }))

  it.effect("never retries a response the server chose", () =>
    Effect.gen(function*() {
      const response = new HttpClientError.HttpClientError({
        reason: new HttpClientError.StatusCodeError({
          request,
          response: HttpClientResponse.fromWeb(request, new Response("{}", { status: 503 }))
        })
      })
      const { attempts, read } = yield* flaky(1, response)
      expect(Exit.isFailure(yield* Effect.exit(retryTransport(read)))).toBe(true)
      expect(yield* Ref.get(attempts)).toBe(1)
    }))
})
