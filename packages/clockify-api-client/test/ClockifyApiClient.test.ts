import { assert, describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Predicate from "effect/Predicate"
import * as Redacted from "effect/Redacted"
import * as HttpClient from "effect/unstable/http/HttpClient"
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import { ClockifyApiClient, ClockifyApiConfig, make } from "../src/index.js"

/**
 * What the fake transport answers next, and what it was asked.
 *
 * Held at module scope rather than built per test so the client can be composed once, by
 * `it.layer`, instead of provided inside each test body. Each test calls {@link reply} first, which
 * both sets its response and clears the recorded requests, so no test can read another's.
 */
let requests: Array<HttpClientRequest.HttpClientRequest> = []
let respond: (request: HttpClientRequest.HttpClientRequest, callIndex: number) => Response = () =>
  new Response("null", { status: 200, headers: { "content-type": "application/json" } })

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

/** Answer every request in this test the same way. */
const reply = (status: number, body: unknown): void => {
  requests = []
  respond = () => json(status, body)
}

/** Answer request `n` of this test from a function of its index — for paging. */
const replyPerCall = (answer: (callIndex: number) => { status: number; body: unknown }): void => {
  requests = []
  respond = (_request, callIndex) => {
    const { body, status } = answer(callIndex)
    return json(status, body)
  }
}

const suite = ClockifyApiClient.layer.pipe(
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
        const callIndex = requests.length
        requests.push(request)
        return HttpClientResponse.fromWeb(request, respond(request, callIndex))
      })
    )
  ))
)

it.layer(suite)("ClockifyApiClient", (it) => {
  it.effect("authenticates requests and decodes responses with Schema", () =>
    Effect.gen(function*() {
      reply(200, { id: "user-1", name: "Ada", email: "ada@example.com", status: "ACTIVE" })
      const client = yield* ClockifyApiClient
      const user = yield* client.getUser()
      expect(user.id).toBe("user-1")
      expect(user.status).toBe("ACTIVE")
      expect(requests).toHaveLength(1)
      expect(requests[0]?.url).toBe("https://clockify.test/api/v1/user")
      expect(requests[0]?.headers["x-api-key"]).toBe("secret")
    }))

  it.effect("decodes nullable interval fields for a running time entry", () =>
    Effect.gen(function*() {
      reply(200, [{
        id: "entry-1",
        description: "In progress",
        billable: false,
        userId: "user-1",
        workspaceId: "workspace-1",
        timeInterval: { start: "2026-07-11T08:00:00Z", end: null, duration: null }
      }])
      const client = yield* ClockifyApiClient
      const entry = yield* client.getRunningTimer("workspace-1", "user-1")
      expect(entry?.timeInterval?.end).toBeNull()
      expect(entry?.timeInterval?.duration).toBeNull()
    }))

  it.effect("requests hydrated time-entry details when required by the caller", () =>
    Effect.gen(function*() {
      reply(200, {
        id: "entry-1",
        workspaceId: "workspace-1",
        userId: "user-1",
        description: "Review the widget",
        billable: true,
        customFieldValues: [],
        projectId: "project-1",
        taskId: "task-1",
        tagIds: ["delivery"],
        timeInterval: { start: "2026-07-11T08:00:00Z", end: "2026-07-11T09:00:00Z", duration: "PT1H" }
      })
      const client = yield* ClockifyApiClient
      const entry = yield* client.getTimeEntry("workspace-1", "entry-1", { hydrated: true })
      yield* client.getTimeEntry("workspace-1", "entry-1")
      yield* client.getTimeEntry("workspace-1", "entry-1", { hydrated: false })
      expect(entry.id).toBe("entry-1")
      expect(new Map(requests[0]?.urlParams ?? []).get("hydrated")).toBe("true")
      expect(new Map(requests[1]?.urlParams ?? []).has("hydrated")).toBe(false)
      expect(new Map(requests[2]?.urlParams ?? []).get("hydrated")).toBe("false")
    }))

  it.effect("forwards hydration when listing canonical time-entry snapshots", () =>
    Effect.gen(function*() {
      reply(200, [])
      const client = yield* ClockifyApiClient
      yield* client.getTimeEntries("workspace-1", "user-1", { hydrated: true, page: 2, pageSize: 10 })
      expect(new Map(requests[0]?.urlParams ?? []).get("hydrated")).toBe("true")
      expect(new Map(requests[0]?.urlParams ?? []).get("page")).toBe("2")
      expect(new Map(requests[0]?.urlParams ?? []).get("page-size")).toBe("10")
    }))

  it.effect("pages through the complete workspace user directory", () =>
    Effect.gen(function*() {
      const firstPage = Array.from({ length: 500 }, (_, index) => ({
        id: `user-${index}`,
        name: `User ${index}`,
        email: `user-${index}@example.test`,
        status: "ACTIVE"
      }))
      // Twenty full pages, then a short one — the only thing that ends the walk.
      replyPerCall((callIndex) => ({
        status: 200,
        body: callIndex < 20
          ? firstPage
          : [{ id: "configured-user", name: "Configured User", email: "configured@example.test", status: "ACTIVE" }]
      }))
      const client = yield* ClockifyApiClient
      if (client.getWorkspaceUsers === undefined) return assert.fail("expected workspace user discovery")
      const users = yield* client.getWorkspaceUsers("workspace-1")
      expect(users).toHaveLength(10_001)
      expect(users.at(-1)?.id).toBe("configured-user")
      expect(requests).toHaveLength(21)
      expect(new Map(requests[0]?.urlParams ?? []).get("page")).toBe("1")
      expect(new Map(requests[20]?.urlParams ?? []).get("page")).toBe("21")
      expect(new Map(requests[0]?.urlParams ?? []).get("account-statuses")).toBe(
        "ACTIVE,PENDING_EMAIL_VERIFICATION,DELETED,NOT_REGISTERED,LIMITED,LIMITED_DELETED"
      )
      expect(new Map(requests[0]?.urlParams ?? []).get("memberships")).toBe("ALL")
    }))

  it.effect("decodes a created time entry whose optional id references are null", () =>
    Effect.gen(function*() {
      // Clockify returns kioskId/projectId/taskId as explicit null (not absent) when unset.
      reply(201, {
        id: "entry-1",
        description: "[PROJ-6169] review the parser",
        billable: true,
        userId: "user-1",
        workspaceId: "workspace-1",
        kioskId: null,
        projectId: null,
        taskId: null,
        tagIds: null,
        timeInterval: { start: "2026-07-20T09:00:00Z", end: null, duration: null }
      })
      const client = yield* ClockifyApiClient
      const entry = yield* client.createTimeEntry("workspace-1", {
        description: "[PROJ-6169] review the parser",
        start: "2026-07-20T09:00:00Z"
      })
      expect(entry.id).toBe("entry-1")
      expect(entry.kioskId).toBeNull()
      expect(entry.projectId).toBeNull()
      expect(entry.taskId).toBeNull()
      expect(entry.tagIds).toBeNull()
    }))

  it.effect("decodes a time-entries list whose entries have null tagIds", () =>
    Effect.gen(function*() {
      // `jcf sync reconcile` fetches time entries; Clockify returns tagIds as
      // null (not an empty array) for entries with no tags.
      reply(200, [{
        id: "entry-1",
        description: "[PROJ-6169] review the parser",
        billable: true,
        userId: "user-1",
        workspaceId: "workspace-1",
        tagIds: null,
        timeInterval: { start: "2026-07-20T09:00:00Z", end: "2026-07-20T11:00:00Z", duration: "PT2H" }
      }])
      const client = yield* ClockifyApiClient
      const entries = yield* client.getTimeEntries("workspace-1", "user-1")
      expect(entries).toHaveLength(1)
      expect(entries[0]?.tagIds).toBeNull()
    }))

  it.effect("fails when a successful response violates the generated schema", () =>
    Effect.gen(function*() {
      reply(200, { id: "user-1" })
      const client = yield* ClockifyApiClient
      const result = yield* Effect.result(client.getUser())
      expect(result._tag).toBe("Failure")
    }))

  it.effect("fails on non-success status codes", () =>
    Effect.gen(function*() {
      reply(401, { message: "Unauthorized" })
      const client = yield* ClockifyApiClient
      const result = yield* Effect.result(client.getUser())
      expect(result._tag).toBe("Failure")
    }))
})

// Builds its own client rather than taking the suite's: the boundary under test is `make` itself,
// which is where the multipart request is constructed.
describe("ClockifyApiClient multipart", () => {
  it.effect("leaves multipart content type unset so the transport can add its boundary", () => {
    const seen: Array<HttpClientRequest.HttpClientRequest> = []
    const httpClient = HttpClient.make((request) =>
      Effect.sync(() => {
        seen.push(request)
        return HttpClientResponse.fromWeb(
          request,
          json(200, { name: "avatar.png", url: "https://clockify.test/avatar.png" })
        )
      })
    )
    const client = make(httpClient, {
      apiKey: Redacted.make("secret"),
      baseUrl: "https://clockify.test/api"
    })

    return Effect.gen(function*() {
      yield* client.uploadImage({ file: new Blob(["avatar bytes"], { type: "image/png" }) })
      expect(seen[0]?.headers["content-type"]).toBeUndefined()
      expect(seen[0]?.body._tag).toBe("FormData")
      if (seen[0]?.body._tag !== "FormData") throw new Error("Expected a FormData request body")
      const file = seen[0].body.formData.get("file")
      expect(seen[0].body.formData).toBeInstanceOf(FormData)
      if (file === null || Predicate.isString(file)) throw new Error("Expected a file field")
      expect(yield* Effect.promise(() => file.text())).toBe("avatar bytes")
      expect(seen[0]?.headers["x-api-key"]).toBe("secret")
    })
  })
})
