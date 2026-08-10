import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient"
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer"
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Ref from "effect/Ref"
import { HttpClient, HttpClientRequest, HttpServer, HttpServerError } from "effect/unstable/http"
import { createServer } from "node:http"
import { callbackServerListenOptions, makeHttpServerFactory, startCallbackServer } from "../src/internal/oauthServer.js"

const EphemeralHttpServerFactoryLive = makeHttpServerFactory(
  () => NodeHttpServer.layerServer(createServer, { port: 0 })
)
const HttpClientLive = NodeHttpClient.layerUndici
const fakeHttpServer = (port: number): HttpServer.HttpServer["Service"] =>
  HttpServer.make({
    address: { _tag: "TcpAddress", hostname: "127.0.0.1", port },
    serve: () => Effect.void
  })

describe("oauth callback server lifecycle", () => {
  it("binds the production callback listener to IPv4 loopback", () => {
    expect(callbackServerListenOptions(8585)).toEqual({ hostname: "127.0.0.1", port: 8585 })
  })

  it.effect("releases the port when authorization exits before receiving a code", () =>
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
    const occupiedFactory = makeHttpServerFactory(({ port }) =>
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

  it.effect("ignores a forged error callback before accepting the legitimate state", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const expectedState = "expected-state"
        const { codePromise, port } = yield* startCallbackServer(expectedState)
        const codeReceiver = yield* Effect.forkChild(codePromise)
        const client = yield* HttpClient.HttpClient

        yield* client.execute(
          HttpClientRequest.get(`http://127.0.0.1:${port}/callback`).pipe(
            HttpClientRequest.setUrlParam("error", "access_denied")
          )
        )
        yield* client.execute(
          HttpClientRequest.get(`http://127.0.0.1:${port}/callback`).pipe(
            HttpClientRequest.setUrlParam("code", "legitimate-code"),
            HttpClientRequest.setUrlParam("state", expectedState)
          )
        )

        expect(yield* Fiber.join(codeReceiver)).toBe("legitimate-code")
      }).pipe(Effect.provide(Layer.mergeAll(EphemeralHttpServerFactoryLive, HttpClientLive)))
    ))

  it.effect("accepts a provider error only after validating state", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const expectedState = "expected-state"
        const { codePromise, port } = yield* startCallbackServer(expectedState)
        const codeReceiver = yield* Effect.forkChild(codePromise)
        const client = yield* HttpClient.HttpClient

        yield* client.execute(
          HttpClientRequest.get(`http://127.0.0.1:${port}/callback`).pipe(
            HttpClientRequest.setUrlParam("error", "access_denied"),
            HttpClientRequest.setUrlParam("state", expectedState)
          )
        )

        const error = yield* Fiber.join(codeReceiver).pipe(Effect.flip)
        expect(String(error.cause)).toContain("access_denied")
      }).pipe(Effect.provide(Layer.mergeAll(EphemeralHttpServerFactoryLive, HttpClientLive)))
    ))
})
