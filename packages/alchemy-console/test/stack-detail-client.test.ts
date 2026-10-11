import { expect, it } from "@effect/vitest"
import { Context, Effect } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import { StackId } from "../src/api.js"
import { readStackDetail } from "../src/client/stack-detail.js"

const id = StackId.make("11111111-1111-4111-8111-111111111111")
const summary = {
  id,
  app: "docs",
  stage: "preview",
  backend: "local",
  alchemyVersion: null,
  lastDeploy: null,
  resourceCount: 0
}
const detail = {
  id,
  state: {
    app: "docs",
    stage: "preview",
    backend: "local",
    alchemyVersion: null,
    lastDeploy: null,
    resources: [],
    outputs: [{ key: "apiUrl", value: { _tag: "Hidden", text: "fixture-secret" }, description: null }],
    props: "fixture-secret"
  }
}

/** Only typed transport is supplied; list refresh precedes get and both use the foreground privacy policy. */
const transport = (status: number, body: string, present = true) =>
  HttpClient.make((request, _url, _signal, fiber) =>
    Effect.sync(() => {
      expect(request.method).toBe("GET")
      expect(Context.getOrUndefined(fiber.context, FetchHttpClient.RequestInit)).toEqual({
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error"
      })
      const list = new URL(request.url).pathname === "/api/stacks"
      const payload = list ? JSON.stringify({ stacks: present ? [summary] : [], issues: [] }) : body
      return HttpClientResponse.fromWeb(
        request,
        new Response(payload, { status: list ? 200 : status, headers: { "content-type": "application/json" } })
      )
    })
  ).pipe(HttpClient.mapRequest(HttpClientRequest.prependUrl("http://127.0.0.1:3114")))

it.effect("detail decoding removes extra fields and transport values from Hidden outputs", () =>
  Effect.gen(function*() {
    const state = yield* readStackDetail(id).pipe(
      Effect.provideService(HttpClient.HttpClient, transport(200, JSON.stringify(detail)))
    )
    expect(state._tag).toBe("Ready")
    expect(JSON.stringify(state)).not.toContain("fixture-secret")
    if (state._tag === "Ready") {
      expect(state.stack.outputs).toEqual([{ key: "apiUrl", value: { _tag: "Hidden" }, description: null }])
    }
  }))
for (
  const fixture of [
    { status: 401, body: "", expected: { _tag: "Unauthorized", reason: "session" } },
    { status: 403, body: "", expected: { _tag: "Failed", reason: "forbidden" } },
    { status: 404, body: JSON.stringify({ _tag: "StackNotFound" }), expected: { _tag: "NotFound" } },
    {
      status: 503,
      body: JSON.stringify({ _tag: "CatalogReadError", reason: "denied", cause: "fixture-secret" }),
      expected: { _tag: "Failed", reason: "denied" }
    },
    {
      status: 200,
      body: JSON.stringify({ ...detail, state: { resources: "fixture-secret" } }),
      expected: { _tag: "Failed", reason: "invalid-response" }
    }
  ]
) {
  it.effect(`detail HTTP ${fixture.status} replaces state with a typed failure`, () =>
    Effect.gen(function*() {
      const state = yield* readStackDetail(id).pipe(
        Effect.provideService(HttpClient.HttpClient, transport(fixture.status, fixture.body))
      )
      expect(state).toEqual(fixture.expected)
      expect(JSON.stringify(state)).not.toContain("fixture-secret")
    }))
}
it.effect("a disappeared catalog entry has no stale detail read", () =>
  Effect.gen(function*() {
    expect(
      yield* readStackDetail(id).pipe(
        Effect.provideService(HttpClient.HttpClient, transport(200, JSON.stringify(detail), false))
      )
    )
      .toEqual({ _tag: "NotFound" })
  }))
