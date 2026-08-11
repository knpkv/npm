/**
 * Local HTTP server for OAuth callback.
 *
 * @module
 */
import * as Context from "effect/Context"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
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
  readonly createServerLayer: (options: CallbackServerListenOptions) => Layer.Layer<
    HttpServer.HttpServer,
    HttpServerError.ServeError,
    never
  >
}

export interface CallbackServerListenOptions {
  readonly host: "127.0.0.1"
  readonly port: number
}

export const callbackServerListenOptions = (port: number): CallbackServerListenOptions => ({
  host: "127.0.0.1",
  port
})

export const callbackUrl = (port: number): string => `http://localhost:${port}/callback`

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
  createLayerFn: (
    options: CallbackServerListenOptions
  ) => Layer.Layer<HttpServer.HttpServer, HttpServerError.ServeError, never>
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
  /** The port the server is listening on */
  readonly port: number
}

const AddressInUseCause = Schema.Struct({
  code: Schema.Literal("EADDRINUSE")
})

const isAddressInUse = (error: HttpServerError.ServeError): boolean => Schema.is(AddressInUseCause)(error.cause)

/**
 * Start a local HTTP server to receive OAuth callback.
 *
 * @param expectedState - The state parameter to verify against CSRF
 * @returns Server control interface with code promise and port
 *
 * @category OAuth
 */
export const startCallbackServer = (
  expectedState: string
): Effect.Effect<CallbackServerResult, OAuthError, HttpServerFactoryTag | Scope.Scope> =>
  Effect.gen(function*() {
    const factory = yield* HttpServerFactoryTag
    const deferred = yield* Deferred.make<string, OAuthError>()
    const readyDeferred = yield* Deferred.make<void, OAuthError>()
    const scope = yield* Effect.scope

    const buildServer = (port: number): Effect.Effect<HttpServerInstance, HttpServerError.ServeError> =>
      Layer.build(factory.createServerLayer(callbackServerListenOptions(port))).pipe(
        Scope.provide(scope),
        Effect.map((context) => Context.get(context, HttpServer.HttpServer)),
        Effect.catchIf(
          (error) => isAddressInUse(error) && port < MAX_PORT,
          () => buildServer(port + 1)
        )
      )

    const server = yield* buildServer(DEFAULT_PORT).pipe(
      Effect.mapError((cause) => new OAuthError({ step: "authorize", cause }))
    )

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
        const url = new URL(req.url, callbackUrl(port))
        const code = url.searchParams.get("code")
        const state = url.searchParams.get("state")
        const error = url.searchParams.get("error")
        const errorDescription = url.searchParams.get("error_description")

        if (state !== expectedState) {
          return HttpServerResponse.html(
            "<html><body><h1>Security Error</h1><p>State verification failed.</p></body></html>"
          ).pipe(
            HttpServerResponse.setStatus(403)
          )
        }

        if (error) {
          yield* Deferred.fail(
            deferred,
            new OAuthError({ step: "authorize", cause: errorDescription || error })
          )
          return HttpServerResponse.html(
            "<html><body><h1>Authorization Failed</h1><p>You can close this window.</p></body></html>"
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

    yield* HttpServer.serveEffect(router.asHttpEffect()).pipe(
      Effect.provideService(HttpServer.HttpServer, server),
      Effect.tap(() => Deferred.succeed(readyDeferred, undefined)),
      Effect.tapError((err) => Deferred.fail(readyDeferred, new OAuthError({ step: "authorize", cause: err }))),
      Effect.forkScoped
    )

    // Wait for server to be ready (or fail)
    yield* Deferred.await(readyDeferred)

    return {
      codePromise: Deferred.await(deferred),
      port
    }
  })
