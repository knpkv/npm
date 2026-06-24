/**
 * Local HTTP server for OAuth callback.
 *
 * @module
 */
import * as Context from "effect/Context"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Scope from "effect/Scope"
import type { HttpServerError } from "effect/unstable/http"
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { OAuthError } from "../ConfluenceError.js"

const DEFAULT_PORT = 8585
const MAX_PORT = 8594
type HttpServerInstance = Effect.Success<typeof HttpServer.HttpServer>

/**
 * Factory service for creating HTTP servers.
 * This allows mocking the server creation in tests.
 *
 * @category Services
 */
export interface HttpServerFactory {
  readonly createServerLayer: (port: number) => Layer.Layer<
    HttpServer.HttpServer,
    HttpServerError.ServeError,
    never
  >
}

/**
 * Tag for the HttpServerFactory service.
 *
 * @category Services
 */
export class HttpServerFactoryTag extends Context.Service<
  HttpServerFactoryTag,
  HttpServerFactory
>()("@knpkv/confluence-to-markdown/HttpServerFactory") {}

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
  createLayerFn: (port: number) => Layer.Layer<HttpServer.HttpServer, HttpServerError.ServeError, never>
): Layer.Layer<HttpServerFactoryTag> =>
  Layer.succeed(HttpServerFactoryTag, {
    createServerLayer: createLayerFn
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
    const deferred = yield* Deferred.make<string, OAuthError>()
    const readyDeferred = yield* Deferred.make<void, OAuthError>()
    const scope = yield* Scope.make()

    const buildServer = (port: number): Effect.Effect<HttpServerInstance, OAuthError> =>
      Layer.build(factory.createServerLayer(port)).pipe(
        Scope.provide(scope),
        Effect.map((context) => Context.get(context, HttpServer.HttpServer)),
        Effect.catchCause((cause) =>
          port < MAX_PORT
            ? buildServer(port + 1)
            : Effect.fail(new OAuthError({ step: "authorize", cause }))
        )
      )

    const server = yield* buildServer(DEFAULT_PORT)

    if (server.address._tag !== "TcpAddress") {
      return yield* Effect.fail(
        new OAuthError({ step: "authorize", cause: "OAuth callback server did not bind to a TCP address" })
      )
    }
    const port = server.address.port

    const router = yield* HttpRouter.make
    yield* router.add(
      "GET",
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

    const serverFiber = yield* HttpServer.serveEffect(router.asHttpEffect()).pipe(
      Effect.provideService(HttpServer.HttpServer, server),
      Scope.provide(scope),
      Effect.tap(() => Deferred.succeed(readyDeferred, undefined)),
      Effect.tapError((err) => Deferred.fail(readyDeferred, new OAuthError({ step: "authorize", cause: err }))),
      Effect.forkIn(scope)
    )

    // Wait for server to be ready (or fail)
    yield* Deferred.await(readyDeferred)

    return {
      codePromise: Deferred.await(deferred),
      shutdown: Fiber.interrupt(serverFiber).pipe(
        Effect.andThen(Scope.close(scope, Exit.void)),
        Effect.asVoid
      ),
      port
    }
  })
