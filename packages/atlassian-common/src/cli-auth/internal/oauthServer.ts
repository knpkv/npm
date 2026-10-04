/**
 * Local HTTP callback server for OAuth2 authorization code capture.
 *
 * **Mental model**
 *
 * - **Scope-owned lifecycle**: {@link startCallbackServer} returns a `codePromise`
 *   (Deferred). The server validates the CSRF `state` parameter, resolves the
 *   Deferred with the authorization code, and stops when its enclosing scope closes.
 * - **Port auto-discovery**: Tries default port 8585, increments on conflict up to 8594.
 * - **Ready before return**: the handler is installed before the port is handed back,
 *   so the caller never advertises a callback URL nothing answers.
 *
 * @internal
 */
import * as Context from "effect/Context"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http"
import type * as HttpServerError from "effect/http/HttpServerError"
import * as Layer from "effect/Layer"
import { NetAddress } from "effect/net"
import * as Schema from "effect/Schema"
import * as Scope from "effect/Scope"
import { OAuthError } from "../../auth/OAuthErrors.js"

const DEFAULT_PORT = 8585
const MAX_PORT = 8594
type HttpServerInstance = Effect.Success<typeof HttpServer.HttpServer>

/**
 * Creates the platform HTTP server for one listen attempt. The Node adapter is
 * {@link HttpServerFactoryLive}; tests substitute ephemeral or failing servers.
 */
export interface HttpServerFactory {
  readonly createServerLayer: (options: CallbackServerListenOptions) => Layer.Layer<
    HttpServer.HttpServer,
    HttpServerError.ServeError,
    never
  >
}

export interface CallbackServerListenOptions {
  readonly host: "localhost"
  readonly port: number
}

export const callbackServerListenOptions = (port: number): CallbackServerListenOptions => ({
  host: "localhost",
  port
})

export const callbackUrl = (port: number): string => `http://localhost:${port}/callback`

export class HttpServerFactoryTag extends Context.Service<
  HttpServerFactoryTag,
  HttpServerFactory
>()("@knpkv/atlassian-common/cli-auth/HttpServerFactory") {}

/** Builds a {@link HttpServerFactoryTag} layer from a per-attempt server layer. */
export const makeHttpServerFactory = (
  createLayerFn: (
    options: CallbackServerListenOptions
  ) => Layer.Layer<HttpServer.HttpServer, HttpServerError.ServeError, never>
): Layer.Layer<HttpServerFactoryTag> =>
  Layer.succeed(HttpServerFactoryTag, {
    createServerLayer: createLayerFn
  })

export interface CallbackServerResult {
  /** Resolves with the authorization code, or fails with the provider's error. */
  readonly codePromise: Effect.Effect<string, OAuthError>
  /** The port the server is listening on */
  readonly port: number
}

const AddressInUseCause = Schema.Struct({
  code: Schema.Literal("EADDRINUSE")
})

const isAddressInUse = (error: HttpServerError.ServeError): boolean => Schema.is(AddressInUseCause)(error.cause)

const page = (heading: string, body: string) =>
  HttpServerResponse.html(`<html><body><h1>${heading}</h1><p>${body}</p></body></html>`)

/**
 * Start a local HTTP server to receive the OAuth callback for `expectedState`.
 *
 * Fails with one `OAuthError` (step `authorize`) when no port in range can be
 * bound; the server stops when the enclosing scope closes.
 */
export const startCallbackServer = (
  expectedState: string
): Effect.Effect<CallbackServerResult, OAuthError, HttpServerFactoryTag | Scope.Scope> =>
  Effect.gen(function*() {
    const factory = yield* HttpServerFactoryTag
    const deferred = yield* Deferred.make<string, OAuthError>()
    const readyDeferred = yield* Deferred.make<void, OAuthError>()
    const scope = yield* Effect.scope

    // Map to OAuthError once, outside the retry, so a run of occupied ports
    // does not nest one OAuthError inside another.
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

    if (!NetAddress.isInetAddress(server.address)) {
      return yield* new OAuthError({ step: "authorize", cause: "OAuth callback server must listen on a TCP port" })
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
          return page("Security Error", "State verification failed.").pipe(HttpServerResponse.setStatus(403))
        }

        if (error !== null && error !== "") {
          // An empty description is no description: report the error code instead.
          yield* Deferred.fail(
            deferred,
            new OAuthError({
              step: "authorize",
              cause: errorDescription === null || errorDescription === "" ? error : errorDescription
            })
          )
          return page("Authorization Failed", "You can close this window.")
        }

        if (code === null || code === "") {
          yield* Deferred.fail(deferred, new OAuthError({ step: "authorize", cause: "No authorization code received" }))
          return page("Error", "No authorization code received.")
        }

        yield* Deferred.succeed(deferred, code)
        return page("Success!", "You can close this window and return to the terminal.")
      })
    )

    yield* HttpServer.serveEffect(router.asHttpEffect()).pipe(
      Effect.provideService(HttpServer.HttpServer, server),
      Effect.tap(() => Deferred.succeed(readyDeferred, undefined)),
      Effect.tapError((cause) => Deferred.fail(readyDeferred, new OAuthError({ step: "authorize", cause }))),
      Effect.forkScoped
    )
    yield* Deferred.await(readyDeferred)

    return {
      codePromise: Deferred.await(deferred),
      port
    }
  })
