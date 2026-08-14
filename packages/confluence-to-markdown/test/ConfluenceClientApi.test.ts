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

/** One stubbed response per request, so a paginated call can be followed. */
const sequenceClientLayer = (
  bodies: ReadonlyArray<unknown>,
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
          const body = bodies[requests.length] ?? bodies[bodies.length - 1]
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

  // `position` and `childPosition` are nullable integers upstream, which the
  // generator renders as `never` unless the spec is patched — a real folder
  // body then fails the generated decode before the domain schema is reached.
  it.effect("decodes a folder carrying a position and a null parent", () => {
    const requests: Array<HttpClientRequest.HttpClientRequest> = []
    return Effect.gen(function*() {
      const client = yield* ConfluenceClient
      const folder = yield* client.getFolder("2964717585")

      expect(folder).toEqual({
        id: "2964717585",
        title: "OOB 99",
        type: "folder",
        status: "current",
        parentId: null,
        parentType: null,
        spaceId: "98765",
        _links: { webui: "/spaces/RPS/folder/2964717585" }
      })
      expect(requests).toHaveLength(1)
    }).pipe(
      Effect.provide(clientLayer({
        id: "2964717585",
        title: "OOB 99",
        type: "folder",
        status: "current",
        parentId: null,
        parentType: null,
        position: 3,
        spaceId: "98765",
        _links: { webui: "/spaces/RPS/folder/2964717585" }
      }, requests))
    )
  })

  // The v2 folder endpoints return `createdAt` as epoch milliseconds even though
  // the upstream spec declares an ISO string, so an unpatched schema fails the
  // generated decode on every real folder. Verified live against
  // `GET /folders/{id}`, which returned 1786546801420.
  it.effect("accepts an epoch-millisecond createdAt and reports it as ISO-8601", () => {
    const requests: Array<HttpClientRequest.HttpClientRequest> = []
    return Effect.gen(function*() {
      const client = yield* ConfluenceClient
      const folder = yield* client.getFolder("2967109643")

      expect(folder.createdAt).toBe("2026-08-12T15:00:01.420Z")
    }).pipe(
      Effect.provide(clientLayer({
        id: "2967109643",
        title: "OOB 100",
        type: "folder",
        status: "current",
        parentId: "2931720217",
        parentType: "folder",
        position: null,
        spaceId: "1843953672",
        createdAt: 1786546801420
      }, requests))
    )
  })

  // The nearby valid fixture: a folder that does honour the spec must still
  // decode, and must not be reformatted.
  it.effect("passes an ISO-8601 createdAt through untouched", () => {
    const requests: Array<HttpClientRequest.HttpClientRequest> = []
    return Effect.gen(function*() {
      const client = yield* ConfluenceClient
      const folder = yield* client.getFolder("2964717585")

      expect(folder.createdAt).toBe("2026-08-12T15:00:01.420Z")
    }).pipe(
      Effect.provide(clientLayer({
        id: "2964717585",
        title: "OOB 99",
        type: "folder",
        status: "current",
        parentId: null,
        parentType: null,
        position: null,
        spaceId: "98765",
        createdAt: "2026-08-12T15:00:01.420Z"
      }, requests))
    )
  })

  it.effect("decodes a created folder whose position is null", () => {
    const requests: Array<HttpClientRequest.HttpClientRequest> = []
    return Effect.gen(function*() {
      const client = yield* ConfluenceClient
      const created = yield* client.createFolder({ spaceId: "98765", title: "OOB 100", parentId: "123" })

      expect(created.id).toBe("2964717586")
      expect(created.title).toBe("OOB 100")
    }).pipe(
      Effect.provide(clientLayer({
        id: "2964717586",
        title: "OOB 100",
        type: "folder",
        status: "current",
        parentId: "123",
        parentType: "folder",
        position: null,
        spaceId: "98765"
      }, requests))
    )
  })

  it.effect("follows folder children pagination", () => {
    const requests: Array<HttpClientRequest.HttpClientRequest> = []
    return Effect.gen(function*() {
      const client = yield* ConfluenceClient
      const children = yield* client.getFolderChildren("2964717585")

      expect(children).toEqual([
        { id: "1", title: "Release Notes", type: "page", status: "current" },
        { id: "2", title: "Sub-folder", type: "folder", status: "current" }
      ])
      expect(requests).toHaveLength(2)
      expect(requests[1]?.urlParams.params).toEqual([["cursor", "next-page"]])
    }).pipe(
      Effect.provide(sequenceClientLayer([
        {
          results: [{ id: "1", title: "Release Notes", type: "page", status: "current", childPosition: 0 }],
          _links: { next: "/wiki/api/v2/folders/2964717585/direct-children?cursor=next-page" }
        },
        {
          results: [{ id: "2", title: "Sub-folder", type: "folder", status: "current", childPosition: null }],
          _links: {}
        }
      ], requests))
    )
  })

  it.effect("reports the CQL total alongside the returned page of hits", () => {
    const requests: Array<HttpClientRequest.HttpClientRequest> = []
    return Effect.gen(function*() {
      const client = yield* ConfluenceClient
      const response = yield* client.searchByCql("title ~ \"OOB 99\"", { limit: 1 })

      expect(response.results).toEqual([{
        title: "OOB 99 Release Notes",
        url: "/spaces/RPS/pages/123/OOB+99",
        entityType: "content",
        lastModified: "2026-01-05T10:00:00.000Z",
        content: { id: "123", type: "page", status: "current" }
      }])
      // Confluence found more than this page holds; the caller has to be able
      // to tell that from a complete answer.
      expect(response.totalSize).toBe(7)
      expect(requests[0]?.urlParams.params).toEqual([["cql", "title ~ \"OOB 99\""], ["limit", "1"]])
    }).pipe(
      Effect.provide(clientLayer({
        results: [{
          content: { id: "123", type: "page", status: "current" },
          title: "OOB 99 Release Notes",
          excerpt: "Release notes for OOB 99",
          url: "/spaces/RPS/pages/123/OOB+99",
          breadcrumbs: [],
          entityType: "content",
          iconCssClass: "aui-iconfont-page-default",
          lastModified: "2026-01-05T10:00:00.000Z"
        }],
        start: 0,
        limit: 1,
        size: 1,
        totalSize: 7,
        cqlQuery: "title ~ \"OOB 99\"",
        searchDuration: 12,
        _links: { base: "https://example.atlassian.net/wiki" }
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
