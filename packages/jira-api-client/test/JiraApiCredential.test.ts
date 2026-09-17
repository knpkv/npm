/**
 * How a request proves who is asking, and when that proof is re-read.
 *
 * These build the client with {@link make} rather than through its Layer, because the credential is
 * resolved inside request preprocessing — the thing under test is what reaches the wire on the
 * *second* call, which needs nothing from the environment to observe.
 */
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import * as HttpClient from "effect/unstable/http/HttpClient"
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import { type JiraApiCredential, make } from "../src/index.js"

/** An http client that answers every request the same way and records what it was asked. */
const recording = (requests: Array<HttpClientRequest.HttpClientRequest>) =>
  HttpClient.make((request) =>
    Effect.sync(() => {
      requests.push(request)
      return HttpClientResponse.fromWeb(
        request,
        new Response(JSON.stringify({ id: "10001", key: "PROJ-1", fields: {} }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      )
    })
  )

const staleCredential: JiraApiCredential = {
  type: "oauth2",
  accessToken: Redacted.make("stale"),
  cloudId: "cloud-123"
}

describe("JiraApiClient credentials", () => {
  // A client is built once and can outlive its credential: `jcf watch` runs all day on an access
  // token good for about an hour. Before this, the token was read once when the client was built and
  // baked into a header, so every request after the first expiry 401ed for the life of the process.
  it.effect("re-reads a refreshing credential on every request", () =>
    Effect.gen(function*() {
      const requests: Array<HttpClientRequest.HttpClientRequest> = []
      let issued = 0
      const client = make(recording(requests), {
        baseUrl: "",
        auth: staleCredential,
        resolveAuth: Effect.sync(() => {
          issued += 1
          return { type: "oauth2", accessToken: Redacted.make(`token-${issued}`), cloudId: "cloud-123" }
        })
      })

      yield* client.getIssue("PROJ-1", undefined)
      yield* client.getIssue("PROJ-1", undefined)

      expect(requests.map((request) => request.headers.authorization)).toEqual([
        "Bearer token-1",
        "Bearer token-2"
      ])
    }))

  // The host comes from the same value as the header, so a resolver cannot address one site while
  // authenticating against another.
  it.effect("routes a refreshed credential at its own cloud id", () =>
    Effect.gen(function*() {
      const requests: Array<HttpClientRequest.HttpClientRequest> = []
      const client = make(recording(requests), {
        baseUrl: "",
        auth: staleCredential,
        resolveAuth: Effect.succeed({
          type: "oauth2",
          accessToken: Redacted.make("fresh"),
          cloudId: "cloud-999"
        })
      })

      yield* client.getIssue("PROJ-1", undefined)

      expect(requests[0]?.url).toBe("https://api.atlassian.com/ex/jira/cloud-999/rest/api/3/issue/PROJ-1")
      expect(requests[0]?.headers.authorization).toBe("Bearer fresh")
    }))

  // Omitting `resolveAuth` must keep the previous behaviour exactly — right for a basic-auth API
  // token, which cannot expire and so has nothing to re-read.
  it.effect("uses the given credential unchanged when no resolver is supplied", () =>
    Effect.gen(function*() {
      const requests: Array<HttpClientRequest.HttpClientRequest> = []
      const client = make(recording(requests), {
        baseUrl: "https://jira.test",
        auth: { type: "basic", email: "user@example.com", apiToken: Redacted.make("test-token") }
      })

      yield* client.getIssue("PROJ-1", undefined)
      yield* client.getIssue("PROJ-1", undefined)

      expect(requests[0]?.url).toBe("https://jira.test/rest/api/3/issue/PROJ-1")
      expect(requests.map((request) => request.headers.authorization)).toEqual([
        requests[0]?.headers.authorization,
        requests[0]?.headers.authorization
      ])
      expect(requests[0]?.headers.authorization).toMatch(/^Basic /)
    }))
})
