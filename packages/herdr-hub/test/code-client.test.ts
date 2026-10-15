// @vitest-environment happy-dom
import { expect, it } from "@effect/vitest"
import type { CodeReviewResult } from "@knpkv/codecommit-web/host"
import { Effect, Result } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { loadCodeContent, loadCodeDetail, loadCodeDiff, loadCodeQueue, loadCodeReview } from "../src/code-client.js"

const ref = "00000000-0000-4000-8000-000000000001"
it.effect("refuses a valid review DTO for a different opaque PR without emitting its content", () =>
  Effect.gen(function*() {
    const other = "00000000-0000-4000-8000-000000000002"
    for (const subjectId of [ref, other]) {
      const value: CodeReviewResult = {
        _tag: "Ready",
        reading: {
          diff: {
            pullRequestId: "7",
            revisionId: "revision",
            baseCommit: "base",
            headCommit: "head",
            readAt: 1_000,
            cacheUpdatedAt: 900,
            files: []
          },
          workspace: {
            identity: {
              namespace: "codecommit",
              subjectId,
              revisionId: "revision",
              baseRevision: "base",
              headRevision: "head"
            },
            observedAt: 1_000,
            run: { _tag: "NotRecorded" },
            checks: { _tag: "Unknown" },
            conversations: { _tag: "Ready", observedAt: 900, threads: [] }
          }
        }
      }
      const client = HttpClient.make((request) =>
        Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(value)))
      )
      const result = yield* Effect.result(loadCodeReview(ref)).pipe(
        Effect.provideService(HttpClient.HttpClient, client)
      )
      if (subjectId === ref) expect(result).toEqual(Result.succeed(value))
      else {
        expect(Result.isFailure(result)).toBe(true)
        if (Result.isFailure(result)) expect(result.failure.reason).toBe("invalid_response")
      }
    }
  }))
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
      yield* loadCodeReview(ref)
      yield* loadCodeContent({ ref, revisionId: "revision", baseCommit: "base", headCommit: "head", fileIndex: 2 })
    }).pipe(Effect.provideService(HttpClient.HttpClient, client))
    expect(urls).toEqual([
      "/v1/modules/code/queue?filter=reviews&search=a+%26+b&offset=50",
      `/v1/modules/code/detail?ref=${ref}`,
      `/v1/modules/code/diff?ref=${ref}`,
      `/v1/modules/code/review?ref=${ref}`,
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
        [200, "{" + " ".repeat(524_289), "invalid_response"],
        ...["https://127.0.0.1:4780", "http://user:pass@127.0.0.1:4780", "http://example.com:4780"].map(
          (ownerUi) =>
            [
              200,
              JSON.stringify({ _tag: "Unavailable", reason: "cache_unavailable", host: null, ownerUi }),
              "invalid_response"
            ] satisfies readonly [number, string, string]
        )
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
