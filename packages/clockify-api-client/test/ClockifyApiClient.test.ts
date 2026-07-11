import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as HttpClient from "effect/unstable/http/HttpClient"
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import { ClockifyApiClient, ClockifyApiConfig } from "../src/index.js"

const clientLayer = (
  response: { readonly status: number; readonly body: unknown },
  requests: Array<HttpClientRequest.HttpClientRequest>
) =>
  ClockifyApiClient.layer.pipe(
    Layer.provide(Layer.succeed(ClockifyApiConfig, {
      apiKey: Redacted.make("secret"),
      workspaceId: "workspace-1",
      userId: "user-1",
      baseUrl: "https://clockify.test/api"
    })),
    Layer.provide(Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.sync(() => {
          requests.push(request)
          return HttpClientResponse.fromWeb(
            request,
            new Response(JSON.stringify(response.body), {
              status: response.status,
              headers: { "content-type": "application/json" }
            })
          )
        })
      )
    ))
  )

describe("ClockifyApiClient", () => {
  it.effect("authenticates requests and decodes responses with Schema", () => {
    const requests: Array<HttpClientRequest.HttpClientRequest> = []
    return Effect.gen(function*() {
      const client = yield* ClockifyApiClient
      const user = yield* client.getUser()
      expect(user.id).toBe("user-1")
      expect(requests).toHaveLength(1)
      expect(requests[0]?.url).toBe("https://clockify.test/api/v1/user")
      expect(requests[0]?.headers["x-api-key"]).toBe("secret")
    }).pipe(
      Effect.provide(clientLayer({
        status: 200,
        body: { id: "user-1", name: "Ada", email: "ada@example.com" }
      }, requests))
    )
  })

  it.effect("fails when a successful response violates the generated schema", () =>
    Effect.gen(function*() {
      const client = yield* ClockifyApiClient
      const result = yield* Effect.result(client.getUser())
      expect(result._tag).toBe("Failure")
    }).pipe(Effect.provide(clientLayer({ status: 200, body: { id: "user-1" } }, []))))

  it.effect("fails on non-success status codes", () =>
    Effect.gen(function*() {
      const client = yield* ClockifyApiClient
      const result = yield* Effect.result(client.getUser())
      expect(result._tag).toBe("Failure")
    }).pipe(Effect.provide(clientLayer({ status: 401, body: { message: "Unauthorized" } }, []))))
})
