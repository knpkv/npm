import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient"
import * as HttpClient from "@effect/platform/HttpClient"
import * as HttpClientRequest from "@effect/platform/HttpClientRequest"
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import { HttpServerFactoryLive } from "../src/internal/NodeLayers.js"
import { startCallbackServer } from "../src/internal/oauthServer.js"

const HttpClientLive = NodeHttpClient.layer

describe("oauthServer", () => {
  describe("startCallbackServer", () => {
    it.effect("starts server and returns port", () =>
      Effect.gen(function*() {
        const expectedState = "test-state-123"
        const result = yield* startCallbackServer(expectedState)

        expect(result.port).toBeGreaterThanOrEqual(8585)
        expect(typeof result.codePromise).toBe("object")
        expect(typeof result.shutdown).toBe("object")

        // Clean up
        yield* result.shutdown
      }).pipe(Effect.provide(HttpServerFactoryLive)))

    it.effect("handles successful callback with code", () =>
      Effect.gen(function*() {
        const expectedState = "test-state-456"
        const { codePromise, port, shutdown } = yield* startCallbackServer(expectedState)

        // Make callback request in background
        const codeReceiver = yield* Effect.fork(codePromise)

        // Simulate OAuth callback using Effect HttpClient
        const client = yield* HttpClient.HttpClient
        const request = HttpClientRequest.get(`http://localhost:${port}/callback`).pipe(
          HttpClientRequest.setUrlParam("code", "auth_code_123"),
          HttpClientRequest.setUrlParam("state", expectedState)
        )
        yield* client.execute(request)

        const code = yield* Fiber.join(codeReceiver)
        expect(code).toBe("auth_code_123")

        yield* shutdown
      }).pipe(Effect.provide(Layer.mergeAll(HttpServerFactoryLive, HttpClientLive))))
  })
})
