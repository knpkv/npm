/**
 * Local HTTP server for OAuth callback.
 *
 * @module
 */
import * as HttpRouter from "@effect/platform/HttpRouter"
import * as HttpServer from "@effect/platform/HttpServer"
import type { ServeError } from "@effect/platform/HttpServerError"
import * as HttpServerRequest from "@effect/platform/HttpServerRequest"
import * as HttpServerResponse from "@effect/platform/HttpServerResponse"
import * as Context from "effect/Context"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import { OAuthError } from "../ConfluenceError.js"

const DEFAULT_PORT = 8585
const MAX_PORT_ATTEMPTS = 10

/**
 * Factory service for creating HTTP servers.
 * This allows mocking the server creation in tests.
 *
 * @category Services
 */
export interface HttpServerFactory {
  readonly createServerLayer: (port: number) => Layer.Layer<
    HttpServer.HttpServer,
    ServeError,
    never
  >
}

/**
 * Tag for the HttpServerFactory service.
 *
 * @category Services
 */
export class HttpServerFactoryTag extends Context.Tag("@knpkv/confluence-to-markdown/HttpServerFactory")<
  HttpServerFactoryTag,
  HttpServerFactory
>() {}

/**
 * Create a HttpServerFactory layer from a layer factory function.
 * This allows injecting platform-specific implementations.
 *
 * @param createLayerFn - Function that creates HttpServer layer for a given port
 * @returns Layer providing HttpServerFactory
 *
 * @category Layers
 */
export const makeHttpServerFactory = (
  createLayerFn: (port: number) => Layer.Layer<HttpServer.HttpServer, ServeError, never>
): Layer.Layer<HttpServerFactoryTag> =>
  Layer.succeed(HttpServerFactoryTag, {
    createServerLayer: createLayerFn
  })

/**
 * Check if a port is available by attempting to start a server.
 */
const isPortAvailable = (port: number): Effect.Effect<boolean, never, HttpServerFactoryTag> =>
  Effect.gen(function*() {
    const factory = yield* HttpServerFactoryTag
    const serverLayer = factory.createServerLayer(port)

    // Try to acquire and immediately release
    const result = yield* Layer.build(serverLayer).pipe(
      Effect.scoped,
      Effect.as(true),
      Effect.catchAll(() => Effect.succeed(false))
    )
    return result
  })

/**
 * Find an available port starting from the default.
 */
const findAvailablePort = (): Effect.Effect<number, OAuthError, HttpServerFactoryTag> =>
  Effect.gen(function*() {
    for (let attempt = 0; attempt < MAX_PORT_ATTEMPTS; attempt++) {
      const port = DEFAULT_PORT + attempt
      const available = yield* isPortAvailable(port)
      if (available) {
        return port
      }
    }
    return yield* Effect.fail(
      new OAuthError({
        step: "authorize",
        cause: `Could not find available port (tried ${DEFAULT_PORT}-${
          DEFAULT_PORT + MAX_PORT_ATTEMPTS - 1
        }). Close other applications using these ports.`
      })
    )
  })

/**
 * Result from the OAuth callback server.
 */
export interface CallbackServerResult {
  /** Promise that resolves with the authorization code */
  readonly codePromise: Effect.Effect<string, OAuthError>
  /** Shutdown the callback server */
  readonly shutdown: Effect.Effect<void, never>
  /** The port the server is listening on */
  readonly port: number
}

/**
 * Start a local HTTP server to receive OAuth callback.
 *
 * @param expectedState - The state parameter to verify against CSRF
 * @returns Server control interface with code promise, shutdown, and port
 *
 * @category OAuth
 */
export const startCallbackServer = (
  expectedState: string
): Effect.Effect<CallbackServerResult, OAuthError, HttpServerFactoryTag> =>
  Effect.gen(function*() {
    const factory = yield* HttpServerFactoryTag
    const port = yield* findAvailablePort()
    const deferred = yield* Deferred.make<string, OAuthError>()
    const readyDeferred = yield* Deferred.make<void, OAuthError>()

    const app = HttpRouter.empty.pipe(
      HttpRouter.get(
        "/callback",
        Effect.gen(function*() {
          const req = yield* HttpServerRequest.HttpServerRequest
          const url = new URL(req.url, `http://localhost:${port}`)
          const code = url.searchParams.get("code")
          const state = url.searchParams.get("state")
          const error = url.searchParams.get("error")
          const errorDescription = url.searchParams.get("error_description")

          if (error) {
            yield* Deferred.fail(
              deferred,
              new OAuthError({ step: "authorize", cause: errorDescription || error })
            )
            return HttpServerResponse.html(
              "<html><body><h1>Authorization Failed</h1><p>You can close this window.</p></body></html>"
            )
          }

          if (state !== expectedState) {
            yield* Deferred.fail(
              deferred,
              new OAuthError({ step: "authorize", cause: "State mismatch - possible CSRF attack" })
            )
            return HttpServerResponse.html(
              "<html><body><h1>Security Error</h1><p>State verification failed.</p></body></html>"
            )
          }

          if (!code) {
            yield* Deferred.fail(
              deferred,
              new OAuthError({ step: "authorize", cause: "No authorization code received" })
            )
            return HttpServerResponse.html(
              "<html><body><h1>Error</h1><p>No authorization code received.</p></body></html>"
            )
          }

          yield* Deferred.succeed(deferred, code)
          return HttpServerResponse.html(
            "<html><body><h1>Success!</h1><p>You can close this window and return to the terminal.</p></body></html>"
          )
        })
      )
    )

    const serverLayer = factory.createServerLayer(port)

    const serverFiber = yield* HttpServer.serve(app).pipe(
      Layer.provide(serverLayer),
      Layer.build,
      Effect.tap(() => Deferred.succeed(readyDeferred, undefined)),
      Effect.tapError((err) => Deferred.fail(readyDeferred, new OAuthError({ step: "authorize", cause: err }))),
      // Keep the layer alive until fiber is interrupted
      Effect.flatMap(() => Effect.never),
      Effect.scoped,
      Effect.fork
    )

    // Wait for server to be ready (or fail)
    yield* Deferred.await(readyDeferred)

    return {
      codePromise: Deferred.await(deferred),
      shutdown: Fiber.interrupt(serverFiber).pipe(Effect.asVoid),
      port
    }
  })
