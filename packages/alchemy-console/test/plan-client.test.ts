import { expect, it } from "@effect/vitest"
import { Context, Effect } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import { readStackPlan } from "../src/client/plan.js"
import { readRoute, routeHref } from "../src/client/route.js"

const id = "11111111-1111-4111-8111-111111111111"
const transport = (status: number, body: string) =>
  HttpClient.make((request, _url, _signal, fiber) =>
    Effect.sync(() => {
      expect(request.method).toBe("GET")
      expect(new URL(request.url).pathname).toBe(`/api/stacks/${id}/plan`)
      expect(Context.getOrUndefined(fiber.context, FetchHttpClient.RequestInit)).toEqual({
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error"
      })
      return HttpClientResponse.fromWeb(
        request,
        new Response(body, { status, headers: { "content-type": "application/json" } })
      )
    })
  ).pipe(HttpClient.mapRequest(HttpClientRequest.prependUrl("http://127.0.0.1:3114")))
it.effect("re-reads Plan using only the authenticated GET route", () =>
  Effect.gen(function*() {
    expect(
      yield* readStackPlan(id).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          transport(200, JSON.stringify({ _tag: "NotPublishing", token: "fixture-private-value" }))
        )
      )
    ).toEqual({ _tag: "Plan", state: { _tag: "NotPublishing" } })
    const route = readRoute(`?stack=${id}&tab=plan`)
    expect(route._tag === "Stack" && route.tab).toBe("plan")
    expect(routeHref(route)).toBe(`/?stack=${id}&tab=plan`)
  }))
for (
  const fixture of [
    { status: 401, body: "", tag: "Unauthorized" },
    { status: 403, body: "", tag: "Failed" },
    { status: 404, body: "{\"_tag\":\"StackNotFound\"}", tag: "NotFound" }
  ]
) {
  it.effect(`owner HTTP ${fixture.status} does not masquerade as CI access refusal`, () =>
    Effect.gen(function*() {
      const result = yield* readStackPlan(id).pipe(
        Effect.provideService(HttpClient.HttpClient, transport(fixture.status, fixture.body))
      )
      expect(result._tag).toBe(fixture.tag)
    }))
}
