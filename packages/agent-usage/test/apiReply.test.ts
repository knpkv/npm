import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { HttpClientRequest, HttpClientResponse } from "effect/http"
import { readReply, RequestFailure } from "../src/client/reply.js"

const reply = (body: string, status: number) =>
  readReply(
    HttpClientResponse.fromWeb(HttpClientRequest.get("http://127.0.0.1/api/status"), new Response(body, { status }))
  )

describe("readReply", () => {
  it.effect("returns a success's JSON body", () =>
    Effect.gen(function*() {
      expect(yield* reply("{\"ok\":true}", 200)).toEqual({ ok: true })
    }))

  // The old fallback turned an unreadable success into `null`, which callers took for an empty result.
  it.effect("fails a success whose body is not JSON, instead of returning nothing", () =>
    Effect.gen(function*() {
      const failure = yield* Effect.flip(reply("<html>proxy</html>", 200))
      expect(failure).toBeInstanceOf(RequestFailure)
      expect(failure).toMatchObject({ message: "The server sent a reply this page cannot read", status: 200 })
    }))

  it.effect("names a failure by the server's message, or by its status when the body is not JSON", () =>
    Effect.gen(function*() {
      expect(yield* Effect.flip(reply("{\"message\":\"Session expired\"}", 401))).toMatchObject({
        message: "Session expired",
        status: 401
      })
      expect(yield* Effect.flip(reply("code already used", 403))).toMatchObject({
        message: "Request failed (403)",
        status: 403
      })
    }))
})
