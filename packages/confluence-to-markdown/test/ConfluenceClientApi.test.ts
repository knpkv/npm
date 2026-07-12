import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as HttpClient from "effect/unstable/http/HttpClient"
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import { PageId } from "../src/Brand.js"
import { ConfluenceClient, layerWithHttpClient } from "../src/ConfluenceClient.js"

const clientLayer = (
  body: unknown,
  requests: Array<HttpClientRequest.HttpClientRequest>
) =>
  layerWithHttpClient({
    baseUrl: "https://example.atlassian.net",
    auth: { type: "token", email: "user@example.com", token: "token" }
  }).pipe(
    Layer.provide(Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.sync(() => {
          requests.push(request)
          return HttpClientResponse.fromWeb(
            request,
            new Response(JSON.stringify(body), {
              status: 200,
              headers: { "content-type": "application/json" }
            })
          )
        })
      )
    ))
  )

describe("ConfluenceClient API boundary", () => {
  it.effect("maps generated childPosition to the domain position", () => {
    const requests: Array<HttpClientRequest.HttpClientRequest> = []
    return Effect.gen(function*() {
      const client = yield* ConfluenceClient
      const children = yield* client.getChildren(PageId("123"))

      expect(children.results).toEqual([{ id: "456", title: "Child", position: 7 }])
      expect(requests).toHaveLength(1)
    }).pipe(
      Effect.provide(clientLayer({
        results: [{ id: "456", title: "Child", childPosition: 7 }],
        _links: {}
      }, requests))
    )
  })

  it.effect("does not retry malformed successful responses", () => {
    const requests: Array<HttpClientRequest.HttpClientRequest> = []
    return Effect.gen(function*() {
      const client = yield* ConfluenceClient
      const result = yield* Effect.result(client.getPage(PageId("123")))

      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(result.failure._tag).toBe("ApiError")
        expect(result.failure.status).toBe(200)
      }
      expect(requests).toHaveLength(1)
    }).pipe(
      Effect.provide(clientLayer({ id: "123", title: "Malformed", position: "first" }, requests))
    )
  })
})
