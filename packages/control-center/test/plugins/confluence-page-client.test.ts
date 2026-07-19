import { assert, describe, it } from "@effect/vitest"
import { ConfluenceApiClient, ConfluenceApiConfig } from "@knpkv/confluence-api-client"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as HttpClient from "effect/unstable/http/HttpClient"
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"

import {
  ConfluencePageClient,
  confluencePageClientLayer
} from "../../src/server/plugins/confluence/ConfluencePageClient.js"

const pageClientLayer = (
  body: unknown,
  requests: Array<HttpClientRequest.HttpClientRequest>
) =>
  confluencePageClientLayer.pipe(
    Layer.provide(ConfluenceApiClient.layer),
    Layer.provide(Layer.succeed(ConfluenceApiConfig, {
      baseUrl: "https://acme.atlassian.net",
      auth: {
        type: "basic",
        email: "owner@example.com",
        apiToken: Redacted.make("secret-token")
      }
    })),
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

describe("Confluence page client", () => {
  it.effect("preserves privacy-redacted watcher identities for adapter normalization", () => {
    const requests: Array<HttpClientRequest.HttpClientRequest> = []
    return Effect.gen(function*() {
      const client = yield* ConfluencePageClient
      const page = yield* client.getPageWatchers("42", 0)

      assert.deepStrictEqual(page, {
        results: [{ type: "watch", contentId: 42, watcher: { accountId: null } }],
        start: 0,
        limit: 50,
        size: 1
      })
      assert.strictEqual(
        requests[0]?.url,
        "https://acme.atlassian.net/wiki/rest/api/content/42/notification/child-created"
      )
    }).pipe(Effect.provide(pageClientLayer({
      results: [{ type: "watch", contentId: 42, watcher: { accountId: null } }],
      start: 0,
      limit: 50,
      size: 1
    }, requests)))
  })

  it.effect("preserves unsafe integral watcher content ids for adapter normalization", () => {
    const requests: Array<HttpClientRequest.HttpClientRequest> = []
    const unsafeContentId = 9_007_199_254_740_992
    return Effect.gen(function*() {
      const client = yield* ConfluencePageClient
      const page = yield* client.getPageWatchers("9007199254740993", 0)

      assert.deepStrictEqual(page, {
        results: [{
          type: "watch",
          contentId: unsafeContentId,
          watcher: { accountId: "account-watcher" }
        }],
        start: 0,
        limit: 50,
        size: 1
      })
    }).pipe(Effect.provide(pageClientLayer({
      results: [{
        type: "watch",
        contentId: unsafeContentId,
        watcher: { accountId: "account-watcher" }
      }],
      start: 0,
      limit: 50,
      size: 1
    }, requests)))
  })
})
