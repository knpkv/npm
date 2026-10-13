import { assert, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as HttpRouter from "effect/http/HttpRouter"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import * as Layer from "effect/Layer"

import { makeVisualRequestAudit } from "../../e2e/visual/requestAudit.js"

it.effect("records each inbound API request once and omits query strings and non-API paths", () =>
  Effect.gen(function*() {
    const audit = makeVisualRequestAudit()
    const routes = Layer.mergeAll(
      HttpRouter.add("GET", "/api/fixture", HttpServerResponse.empty()),
      HttpRouter.add("POST", "/api/fixture", HttpServerResponse.empty()),
      HttpRouter.add("GET", "/", HttpServerResponse.empty())
    ).pipe(Layer.provideMerge(audit.layer))
    yield* Effect.acquireUseRelease(
      Effect.sync(() => HttpRouter.toWebHandler(routes, { disableLogger: true })),
      ({ handler }) =>
        Effect.gen(function*() {
          yield* Effect.promise(() => handler(new Request("http://fixture.test/api/fixture?cursor=12")))
          yield* Effect.promise(() => handler(new Request("http://fixture.test/api/fixture", { method: "POST" })))
          yield* Effect.promise(() => handler(new Request("http://fixture.test/")))
          assert.deepStrictEqual(audit.requests(), [
            { method: "GET", path: "/api/fixture" },
            { method: "POST", path: "/api/fixture" }
          ])
        }),
      ({ dispose }) => Effect.promise(dispose)
    )
  }))
