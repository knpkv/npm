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
  requests: Array<HttpClientRequest.HttpClientRequest>,
  status = 200
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
              status,
              headers: { "content-type": "application/json" }
            })
          )
        })
      )
    ))
  )

describe("Confluence page client", () => {
  it.effect("sends the authorized title, ADF, marker, and exact next version in one update", () => {
    const requests: Array<HttpClientRequest.HttpClientRequest> = []
    const updated = {
      id: "42",
      status: "current",
      title: "Payments release runbook v2",
      spaceId: "space-payments",
      createdAt: "2026-07-01T09:00:00.000Z",
      version: {
        number: 4,
        createdAt: "2026-07-17T10:31:00.000Z",
        message: "Control Center action-17 digest"
      }
    }
    return Effect.gen(function*() {
      const client = yield* ConfluencePageClient
      const result = yield* client.updatePage("42", {
        title: updated.title,
        adf: "{\"content\":[],\"type\":\"doc\",\"version\":1}",
        version: 4,
        versionMessage: updated.version.message
      })

      assert.deepStrictEqual(result, updated)
      assert.strictEqual(requests[0]?.method, "PUT")
      assert.strictEqual(requests[0]?.url, "https://acme.atlassian.net/wiki/api/v2/pages/42")
      assert.strictEqual(requests[0]?.body._tag, "Uint8Array")
      if (requests[0]?.body._tag === "Uint8Array") {
        assert.deepStrictEqual(JSON.parse(new TextDecoder().decode(requests[0].body.body)), {
          id: "42",
          status: "current",
          title: updated.title,
          body: {
            representation: "atlas_doc_format",
            value: "{\"content\":[],\"type\":\"doc\",\"version\":1}"
          },
          version: {
            number: 4,
            message: updated.version.message
          }
        })
      }
    }).pipe(Effect.provide(pageClientLayer(updated, requests)))
  })

  it.effect("classifies a provider version rejection as a conflict", () => {
    const requests: Array<HttpClientRequest.HttpClientRequest> = []
    return Effect.gen(function*() {
      const client = yield* ConfluencePageClient
      const failure = yield* client.updatePage("42", {
        title: "Payments",
        adf: "{\"content\":[],\"type\":\"doc\",\"version\":1}",
        version: 4,
        versionMessage: "Control Center action-17 digest"
      }).pipe(Effect.flip)

      assert.strictEqual(failure.reason, "conflict")
      assert.strictEqual(requests.length, 1)
    }).pipe(Effect.provide(pageClientLayer({ message: "Conflict" }, requests, 409)))
  })

  it.effect("classifies an invalid update as a definite invalid request", () => {
    const requests: Array<HttpClientRequest.HttpClientRequest> = []
    return Effect.gen(function*() {
      const client = yield* ConfluencePageClient
      const failure = yield* client.updatePage("42", {
        title: "Payments",
        adf: "{\"content\":[],\"type\":\"doc\",\"version\":1}",
        version: 4,
        versionMessage: "Control Center action-17 digest"
      }).pipe(Effect.flip)

      assert.strictEqual(failure.reason, "invalid-request")
      assert.strictEqual(requests.length, 1)
    }).pipe(Effect.provide(pageClientLayer({ message: "Invalid request" }, requests, 400)))
  })

  it.effect("reads an exact historical page version without walking pagination", () => {
    const requests: Array<HttpClientRequest.HttpClientRequest> = []
    const version = {
      number: 4,
      createdAt: "2026-07-17T10:31:00.000Z",
      message: "Control Center action-17 digest",
      minorEdit: false,
      authorId: "account-owner"
    }
    return Effect.gen(function*() {
      const client = yield* ConfluencePageClient
      const result = yield* client.getPageVersion("42", 4)

      assert.deepStrictEqual(result, version)
      assert.strictEqual(
        requests[0]?.url,
        "https://acme.atlassian.net/wiki/api/v2/pages/42/versions/4"
      )
    }).pipe(Effect.provide(pageClientLayer(version, requests)))
  })

  it.effect("accepts a space homepage whose provider parent id is null", () => {
    const requests: Array<HttpClientRequest.HttpClientRequest> = []
    const page = {
      id: "262489",
      status: "current",
      title: "Software Development",
      spaceId: "262368",
      parentId: null,
      authorId: "account-owner",
      ownerId: "account-owner",
      createdAt: "2026-06-24T06:45:14.260Z",
      version: {
        number: 1,
        message: "",
        minorEdit: false,
        authorId: "account-owner",
        createdAt: "2026-06-24T06:45:17.307Z"
      },
      body: {
        atlas_doc_format: {
          representation: "atlas_doc_format",
          value: "{}"
        }
      }
    }
    return Effect.gen(function*() {
      const client = yield* ConfluencePageClient
      const result = yield* client.getPage("262489")

      assert.deepStrictEqual(result, page)
      assert.strictEqual(requests[0]?.url, "https://acme.atlassian.net/wiki/api/v2/pages/262489")
      assert.deepStrictEqual(
        new Map(requests[0]?.urlParams ?? []),
        new Map([
          ["body-format", "atlas_doc_format"],
          ["include-version", "true"],
          ["status", "current"]
        ])
      )
    }).pipe(Effect.provide(pageClientLayer(page, requests)))
  })

  it.effect("accepts a space listing containing a null-parent homepage", () => {
    const requests: Array<HttpClientRequest.HttpClientRequest> = []
    const page = {
      id: "262489",
      status: "current",
      title: "Software Development",
      spaceId: "262368",
      parentId: null,
      createdAt: "2026-06-24T06:45:14.260Z",
      version: {
        number: 1,
        createdAt: "2026-06-24T06:45:17.307Z"
      }
    }
    return Effect.gen(function*() {
      const client = yield* ConfluencePageClient
      const result = yield* client.getSpacePages("262368", null)

      assert.deepStrictEqual(result, { results: [page], _links: {} })
      assert.strictEqual(requests[0]?.url, "https://acme.atlassian.net/wiki/api/v2/spaces/262368/pages")
    }).pipe(Effect.provide(pageClientLayer({ results: [page], _links: {} }, requests)))
  })

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
