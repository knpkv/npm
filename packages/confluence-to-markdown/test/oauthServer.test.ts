import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient"
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer"
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Ref from "effect/Ref"
import { HttpClient, HttpClientRequest, HttpServer, HttpServerError } from "effect/unstable/http"
import { createServer } from "node:http"
import { makeHttpServerFactory, startCallbackServer } from "../src/internal/oauthServer.js"

const HttpClientLive = NodeHttpClient.layerUndici
const EphemeralHttpServerFactoryLive = makeHttpServerFactory(
  () => NodeHttpServer.layerServer(createServer, { port: 0 })
)
const fakeHttpServer = (port: number): HttpServer.HttpServer["Service"] =>
  HttpServer.make({
    address: { _tag: "TcpAddress", hostname: "127.0.0.1", port },
    serve: () => Effect.void
  })

describe("oauthServer", () => {
  describe("startCallbackServer", () => {
    it.effect("starts server and returns port", () =>
      Effect.scoped(
        Effect.gen(function*() {
          const expectedState = "test-state-123"
          const result = yield* startCallbackServer(expectedState)

          expect(result.port).toBeGreaterThan(0)
          expect(typeof result.codePromise).toBe("object")
        }).pipe(Effect.provide(EphemeralHttpServerFactoryLive))
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
        }).pipe(Effect.provide(Layer.mergeAll(EphemeralHttpServerFactoryLive, HttpClientLive)))
      ))

    it.effect("releases the callback port when the owning workflow fails", () =>
      Effect.gen(function*() {
        yield* Effect.scoped(
          startCallbackServer("first").pipe(
            Effect.provide(EphemeralHttpServerFactoryLive),
            Effect.andThen(Effect.fail("browser-open-failed")),
            Effect.flip
          )
        )

        const port = yield* Effect.scoped(
          startCallbackServer("second").pipe(
            Effect.provide(EphemeralHttpServerFactoryLive),
            Effect.map((server) => server.port)
          )
        )
        expect(port).toBeGreaterThan(0)
      }))

    it.effect("starts concurrent real callback servers on distinct OS-assigned ports", () =>
      Effect.scoped(
        Effect.gen(function*() {
          const [first, second] = yield* Effect.all(
            [startCallbackServer("first"), startCallbackServer("second")],
            { concurrency: "unbounded" }
          )
          expect(first.port).toBeGreaterThan(0)
          expect(second.port).toBeGreaterThan(0)
          expect(first.port).not.toBe(second.port)
        }).pipe(Effect.provide(EphemeralHttpServerFactoryLive))
      ))

    it.effect("retries occupied fixed-range ports with the injected factory", () => {
      const attempts = Ref.makeUnsafe<ReadonlyArray<number>>([])
      const occupiedFactory = makeHttpServerFactory((port) =>
        Layer.effect(
          HttpServer.HttpServer,
          Ref.update(attempts, (ports) => [...ports, port]).pipe(
            Effect.andThen(
              port < 8587
                ? Effect.fail(new HttpServerError.ServeError({ cause: { code: "EADDRINUSE" } }))
                : Effect.succeed(fakeHttpServer(port))
            )
          )
        )
      )

      return Effect.scoped(
        Effect.gen(function*() {
          const server = yield* startCallbackServer("state")
          expect(server.port).toBe(8587)
          expect(yield* Ref.get(attempts)).toEqual([8585, 8586, 8587])
        }).pipe(Effect.provide(occupiedFactory))
      )
    })

    it.effect("maps a multiply retried server failure to one OAuth error", () => {
      const attempts = Ref.makeUnsafe<ReadonlyArray<number>>([])
      const terminalFailure = new HttpServerError.ServeError({ cause: { code: "EACCES" } })
      const failingFactory = makeHttpServerFactory((port) =>
        Layer.effect(
          HttpServer.HttpServer,
          Ref.update(attempts, (ports) => [...ports, port]).pipe(
            Effect.andThen(
              port < 8587
                ? Effect.fail(new HttpServerError.ServeError({ cause: { code: "EADDRINUSE" } }))
                : Effect.fail(terminalFailure)
            )
          )
        )
      )

      return Effect.scoped(
        Effect.gen(function*() {
          const error = yield* startCallbackServer("state").pipe(Effect.flip)
          expect(error.cause).toBe(terminalFailure)
          expect(error.message.split("OAuth authorize failed:").length - 1).toBe(1)
          expect(yield* Ref.get(attempts)).toEqual([8585, 8586, 8587])
        }).pipe(Effect.provide(failingFactory))
      )
    })

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
