import { assert, describe, it } from "@effect/vitest"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as TestClock from "effect/testing/TestClock"
import * as HttpClientError from "effect/unstable/http/HttpClientError"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"

import { mapJiraReadProviderFailure } from "../../src/server/plugins/jira/JiraReadProvider.js"

const rateLimitError = (retryAfter: string): HttpClientError.HttpClientError => {
  const request = HttpClientRequest.get("https://acme.atlassian.net/rest/api/3/issue/PAY-42")
  const response = HttpClientResponse.fromWeb(
    request,
    new Response(null, { status: 429, headers: { "retry-after": retryAfter } })
  )
  return new HttpClientError.HttpClientError({
    reason: new HttpClientError.StatusCodeError({ request, response })
  })
}

const mapRateLimit = Effect.fn("JiraReadProviderTest.mapRateLimit")(function*(retryAfter: string) {
  const outcome = yield* mapJiraReadProviderFailure("jira-get-issue", rateLimitError(retryAfter)).pipe(
    Effect.result
  )
  if (Result.isSuccess(outcome)) return yield* Effect.die("expected the provider failure mapper to fail")
  assert.strictEqual(outcome.failure._tag, "PluginRateLimitFailure")
  if (outcome.failure._tag !== "PluginRateLimitFailure") {
    return yield* Effect.die("expected a rate-limit failure")
  }
  return outcome.failure.retryAt
})

describe("JiraReadProvider", () => {
  it.effect("maps a numeric Retry-After delta from the current Effect clock", () =>
    Effect.gen(function*() {
      yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe("2026-07-17T12:00:00.000Z")))
      const retryAt = yield* mapRateLimit("5")
      assert.strictEqual(DateTime.formatIso(retryAt), "2026-07-17T12:00:05.000Z")
    }))

  it.effect("maps an HTTP-date Retry-After value from the current Effect clock", () =>
    Effect.gen(function*() {
      yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe("2026-07-17T12:00:00.000Z")))
      const retryAt = yield* mapRateLimit("Fri, 17 Jul 2026 12:00:05 GMT")
      assert.strictEqual(DateTime.formatIso(retryAt), "2026-07-17T12:00:05.000Z")
    }))
})
