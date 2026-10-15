import { expect, it } from "@effect/vitest"
import { StackId } from "../src/api.js"
import { readRoute, routeHref } from "../src/client/route.js"

const id = StackId.make("11111111-1111-4111-8111-111111111111")

it("round-trips only normalized UI identity and never retains unrelated query data", () => {
  const route = { _tag: "Stack", id, resource: "Api/Worker", tab: "state" } satisfies Parameters<typeof routeHref>[0]
  expect(readRoute(routeHref(route).slice(1))).toEqual(route)
  expect(routeHref(readRoute(`?stack=${id}&resource=Api%2FWorker&token=fixture-secret`))).not.toContain(
    "fixture-secret"
  )
  for (
    const search of [
      "?stack=invalid",
      `?stack=${id}&stack=${id}`,
      `?stack=${id}&tab=apply`,
      `?stack=${id}&resource=Api%00Worker`,
      `?stack=${id}&resource=Api%2F%2FWorker`,
      "x".repeat(4097)
    ]
  ) {
    expect(readRoute(search)).toEqual({ _tag: "List" })
  }
})
