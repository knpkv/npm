import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Ref from "effect/Ref"
import { HttpServer, HttpServerError } from "effect/unstable/http"
import { HttpServerFactoryLive } from "../src/internal/NodeLayers.js"
import { makeHttpServerFactory, startCallbackServer } from "../src/internal/oauthServer.js"

describe("oauth callback server lifecycle", () => {
  it.effect("releases the port when authorization exits before receiving a code", () =>
    Effect.gen(function*() {
      yield* Effect.scoped(
        startCallbackServer("first").pipe(
          Effect.provide(HttpServerFactoryLive),
          Effect.andThen(Effect.fail("browser-open-failed")),
          Effect.flip
        )
      )

      const port = yield* Effect.scoped(
        startCallbackServer("second").pipe(
          Effect.provide(HttpServerFactoryLive),
          Effect.map((server) => server.port)
        )
      )
      expect(port).toBe(8585)
    }))

  it.effect("retries an occupied callback port within the owning scope", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const first = yield* startCallbackServer("first")
        const second = yield* startCallbackServer("second")
        expect(first.port).toBe(8585)
        expect(second.port).toBe(8586)
      }).pipe(Effect.provide(HttpServerFactoryLive))
    ))

  it.effect("does not retry a non-address-in-use server failure", () => {
    const attempts = Ref.makeUnsafe(0)
    const failingFactory = makeHttpServerFactory(() =>
      Layer.effect(
        HttpServer.HttpServer,
        Ref.update(attempts, (count) => count + 1).pipe(
          Effect.andThen(Effect.fail(
            new HttpServerError.ServeError({
              cause: { code: "ECONNREFUSED" }
            })
          ))
        )
      )
    )

    return Effect.scoped(
      startCallbackServer("state").pipe(
        Effect.provide(failingFactory),
        Effect.flip,
        Effect.tap(() => Ref.get(attempts).pipe(Effect.map((count) => expect(count).toBe(1))))
      )
    )
  })
})
