// @vitest-environment happy-dom
import { expect, it } from "@effect/vitest"
import { Effect, Result } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { loadCodeContent, loadCodeDetail, loadCodeDiff, loadCodeQueue } from "../src/code-client.js"

const ref = "00000000-0000-4000-8000-000000000001"
it.effect("reads only same-host GET routes with opaque selectors and preserves typed unavailable responses", () =>
  Effect.gen(function*() {
    const urls: Array<string> = []
    const client = HttpClient.make((request) =>
      Effect.sync(() => {
        expect(request.method).toBe("GET")
        urls.push(request.url)
        return HttpClientResponse.fromWeb(
          request,
          Response.json({ _tag: "Unavailable", reason: "permission_required", host: null })
        )
      })
    )
    yield* Effect.gen(function*() {
      expect(yield* loadCodeQueue({ filter: "reviews", search: "a & b", offset: 50 })).toEqual({
        _tag: "Unavailable",
        reason: "permission_required",
        host: null
      })
      yield* loadCodeDetail(ref)
      yield* loadCodeDiff(ref)
      yield* loadCodeContent({ ref, revisionId: "revision", baseCommit: "base", headCommit: "head", fileIndex: 2 })
    }).pipe(Effect.provideService(HttpClient.HttpClient, client))
    expect(urls).toEqual([
      "/v1/modules/code/queue?filter=reviews&search=a+%26+b&offset=50",
      `/v1/modules/code/detail?ref=${ref}`,
      `/v1/modules/code/diff?ref=${ref}`,
      `/v1/modules/code/diff-content?ref=${ref}&revisionId=revision&baseCommit=base&headCommit=head&fileIndex=2`
    ])
  }))

it.effect("refuses malformed bodies and maps status failures without exposing response text", () =>
  Effect.gen(function*() {
    for (
      const [status, body, reason] of [
        [404, "private provider cause", "not_found"],
        [401, "private provider cause", "unauthorized"],
        [503, "private provider cause", "status"],
        [
          200,
          JSON.stringify({ _tag: "Ready", items: [{ title: "not a DTO" }], more: false, observedAt: 1 }),
          "invalid_response"
        ],
        [200, "{" + " ".repeat(524_289), "invalid_response"]
      ] satisfies ReadonlyArray<readonly [number, string, string]>
    ) {
      const client = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(body, { status, headers: { "content-type": "application/json" } })
          )
        )
      )
      const answer = yield* Effect.result(
        loadCodeQueue({ filter: "open", search: "", offset: 0 }).pipe(
          Effect.provideService(HttpClient.HttpClient, client)
        )
      )
      expect(Result.isFailure(answer)).toBe(true)
      if (Result.isFailure(answer)) {
        expect(answer.failure.reason).toBe(reason)
        expect(JSON.stringify(answer.failure)).not.toContain("private provider cause")
      }
    }
  }))
