import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient"
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Ref from "effect/Ref"
import { HttpClient, HttpClientRequest, HttpServer, HttpServerError } from "effect/unstable/http"
import { HttpServerFactoryLive } from "../src/internal/NodeLayers.js"
import { makeHttpServerFactory, startCallbackServer } from "../src/internal/oauthServer.js"

const HttpClientLive = NodeHttpClient.layerUndici

describe("oauthServer", () => {
  describe("startCallbackServer", () => {
    it.effect("starts server and returns port", () =>
      Effect.scoped(
        Effect.gen(function*() {
          const expectedState = "test-state-123"
          const result = yield* startCallbackServer(expectedState)

          expect(result.port).toBe(8585)
          expect(typeof result.codePromise).toBe("object")
        }).pipe(Effect.provide(HttpServerFactoryLive))
      ))

    it.effect("handles successful callback with code", () =>
      Effect.scoped(
        Effect.gen(function*() {
          const expectedState = "test-state-456"
          const { codePromise, port } = yield* startCallbackServer(expectedState)

          // Make callback request in background
          const codeReceiver = yield* Effect.forkChild(codePromise)

          // Simulate OAuth callback using Effect HttpClient
          const client = yield* HttpClient.HttpClient
          const request = HttpClientRequest.get(`http://localhost:${port}/callback`).pipe(
            HttpClientRequest.setUrlParam("code", "auth_code_123"),
            HttpClientRequest.setUrlParam("state", expectedState)
          )
          yield* client.execute(request)

          const code = yield* Fiber.join(codeReceiver)
          expect(code).toBe("auth_code_123")
        }).pipe(Effect.provide(Layer.mergeAll(HttpServerFactoryLive, HttpClientLive)))
      ))

    it.effect("releases the callback port when the owning workflow fails", () =>
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

    it.effect("retries only the occupied callback port", () =>
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
})
