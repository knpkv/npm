import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as HttpClient from "effect/unstable/http/HttpClient"
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import { ClockifyApiClient, ClockifyApiConfig, make } from "../src/index.js"

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
      expect(user.status).toBe("ACTIVE")
      expect(requests).toHaveLength(1)
      expect(requests[0]?.url).toBe("https://clockify.test/api/v1/user")
      expect(requests[0]?.headers["x-api-key"]).toBe("secret")
    }).pipe(
      Effect.provide(clientLayer({
        status: 200,
        body: { id: "user-1", name: "Ada", email: "ada@example.com", status: "ACTIVE" }
      }, requests))
    )
  })

  it.effect("decodes nullable interval fields for a running time entry", () => {
    const requests: Array<HttpClientRequest.HttpClientRequest> = []
    return Effect.gen(function*() {
      const client = yield* ClockifyApiClient
      const entry = yield* client.getRunningTimer("workspace-1", "user-1")
      expect(entry?.timeInterval?.end).toBeNull()
      expect(entry?.timeInterval?.duration).toBeNull()
    }).pipe(
      Effect.provide(clientLayer({
        status: 200,
        body: [{
          id: "entry-1",
          description: "In progress",
          billable: false,
          userId: "user-1",
          workspaceId: "workspace-1",
          timeInterval: {
            start: "2026-07-11T08:00:00Z",
            end: null,
            duration: null
          }
        }]
      }, requests))
    )
  })

  it.effect("pages through the complete workspace user directory", () => {
    const requests: Array<HttpClientRequest.HttpClientRequest> = []
    const firstPage = Array.from({ length: 500 }, (_, index) => ({
      id: `user-${index}`,
      name: `User ${index}`,
      email: `user-${index}@example.test`,
      status: "ACTIVE"
    }))
    const layer = ClockifyApiClient.layer.pipe(
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
            const body = requests.length === 1
              ? firstPage
              : [{ id: "configured-user", name: "Configured User", email: "configured@example.test", status: "ACTIVE" }]
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
    return Effect.gen(function*() {
      const client = yield* ClockifyApiClient
      if (client.getWorkspaceUsers === undefined) return assert.fail("expected workspace user discovery")
      const users = yield* client.getWorkspaceUsers("workspace-1")
      expect(users).toHaveLength(501)
      expect(users.at(-1)?.id).toBe("configured-user")
      expect(requests).toHaveLength(2)
      expect(new Map(requests[0]?.urlParams ?? []).get("page")).toBe("1")
      expect(new Map(requests[1]?.urlParams ?? []).get("page")).toBe("2")
      expect(new Map(requests[0]?.urlParams ?? []).get("account-statuses")).toBe(
        "ACTIVE,PENDING_EMAIL_VERIFICATION,DELETED,NOT_REGISTERED,LIMITED,LIMITED_DELETED"
      )
    }).pipe(Effect.provide(layer))
  })

  it.effect("decodes a created time entry whose optional id references are null", () => {
    const requests: Array<HttpClientRequest.HttpClientRequest> = []
    return Effect.gen(function*() {
      const client = yield* ClockifyApiClient
      // Clockify returns kioskId/projectId/taskId as explicit null (not absent) when unset.
      const entry = yield* client.createTimeEntry("workspace-1", {
        description: "[RPS-6169] review transaction mapper",
        start: "2026-07-20T09:00:00Z"
      })
      expect(entry.id).toBe("entry-1")
      expect(entry.kioskId).toBeNull()
      expect(entry.projectId).toBeNull()
      expect(entry.taskId).toBeNull()
      expect(entry.tagIds).toBeNull()
    }).pipe(
      Effect.provide(clientLayer({
        status: 201,
        body: {
          id: "entry-1",
          description: "[RPS-6169] review transaction mapper",
          billable: true,
          userId: "user-1",
          workspaceId: "workspace-1",
          kioskId: null,
          projectId: null,
          taskId: null,
          tagIds: null,
          timeInterval: {
            start: "2026-07-20T09:00:00Z",
            end: null,
            duration: null
          }
        }
      }, requests))
    )
  })

  it.effect("decodes a time-entries list whose entries have null tagIds", () => {
    const requests: Array<HttpClientRequest.HttpClientRequest> = []
    return Effect.gen(function*() {
      const client = yield* ClockifyApiClient
      // `jcf sync reconcile` fetches time entries; Clockify returns tagIds as
      // null (not an empty array) for entries with no tags.
      const entries = yield* client.getTimeEntries("workspace-1", "user-1")
      expect(entries).toHaveLength(1)
      expect(entries[0]?.tagIds).toBeNull()
    }).pipe(
      Effect.provide(clientLayer({
        status: 200,
        body: [{
          id: "entry-1",
          description: "[RPS-6169] review transaction mapper",
          billable: true,
          userId: "user-1",
          workspaceId: "workspace-1",
          tagIds: null,
          timeInterval: {
            start: "2026-07-20T09:00:00Z",
            end: "2026-07-20T11:00:00Z",
            duration: "PT2H"
          }
        }]
      }, requests))
    )
  })

  it.effect("leaves multipart content type unset so the transport can add its boundary", () => {
    const requests: Array<HttpClientRequest.HttpClientRequest> = []
    const httpClient = HttpClient.make((request) =>
      Effect.sync(() => {
        requests.push(request)
        return HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify({ name: "avatar.png", url: "https://clockify.test/avatar.png" }), {
            status: 200,
            headers: { "content-type": "application/json" }
          })
        )
      })
    )
    const client = make(httpClient, {
      apiKey: Redacted.make("secret"),
      baseUrl: "https://clockify.test/api"
    })

    return Effect.gen(function*() {
      yield* client.uploadImage({ file: new Blob(["avatar bytes"], { type: "image/png" }) })
      expect(requests[0]?.headers["content-type"]).toBeUndefined()
      expect(requests[0]?.body._tag).toBe("FormData")
      if (requests[0]?.body._tag !== "FormData") throw new Error("Expected a FormData request body")
      const file = requests[0].body.formData.get("file")
      expect(requests[0].body.formData).toBeInstanceOf(FormData)
      expect(typeof file).not.toBe("string")
      if (file === null || typeof file === "string") throw new Error("Expected a file field")
      expect(yield* Effect.promise(() => file.text())).toBe("avatar bytes")
      expect(requests[0]?.headers["x-api-key"]).toBe("secret")
    })
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
