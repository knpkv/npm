import { expect, it } from "@effect/vitest"
import { Context, Effect } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import { readStackList } from "../src/client/stack-list.js"

/** Only the typed HTTP boundary is supplied. No Catalog, filesystem, credentials or server services. */
const response = (status: number, body: string) =>
  HttpClient.make((request, _url, _signal, fiber) =>
    Effect.sync(() => {
      const options = Context.getOrUndefined(fiber.context, FetchHttpClient.RequestInit)
      expect(request.method).toBe("GET")
      expect(new URL(request.url).pathname).toBe("/api/stacks")
      expect(options).toEqual({ credentials: "same-origin", cache: "no-store", redirect: "error" })
      return HttpClientResponse.fromWeb(
        request,
        new Response(body, { status, headers: { "content-type": "application/json" } })
      )
    })
  ).pipe(HttpClient.mapRequest(HttpClientRequest.prependUrl("http://127.0.0.1:3114")))

it.effect("decodes only client-safe fields and completes a fresh checked time", () =>
  Effect.gen(function*() {
    const state = yield* readStackList().pipe(
      Effect.provideService(
        HttpClient.HttpClient,
        response(200, JSON.stringify({ stacks: [], issues: [], private: "synthetic-private" }))
      )
    )
    expect(state._tag).toBe("Ready")
    if (state._tag === "Ready") {
      expect(state.list).toEqual({ stacks: [], issues: [] })
      expect(state.checkedAt.length).toBeGreaterThan(0)
    }
    expect(JSON.stringify(state)).not.toContain("synthetic-private")
  }))

for (
  const fixture of [
    { status: 401, body: "", state: { _tag: "Unauthorized", reason: "session" } },
    { status: 403, body: "", state: { _tag: "Failed", reason: "forbidden" } },
    {
      status: 503,
      body: JSON.stringify({ _tag: "CatalogReadError", reason: "denied", cause: "synthetic-private" }),
      state: { _tag: "Failed", reason: "denied" }
    },
    {
      status: 200,
      body: JSON.stringify({ stacks: [{ app: "billing", private: "synthetic-private" }], issues: [] }),
      state: { _tag: "Failed", reason: "invalid-response" }
    }
  ]
) {
  it.effect(`maps HTTP ${fixture.status} to sanitized state ${fixture.state.reason}`, () =>
    Effect.gen(function*() {
      const state = yield* readStackList().pipe(
        Effect.provideService(HttpClient.HttpClient, response(fixture.status, fixture.body))
      )
      expect(state).toEqual(fixture.state)
      expect(JSON.stringify(state)).not.toContain("synthetic-private")
    }))
}
