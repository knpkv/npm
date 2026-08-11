/**
 * Local HTTP callback server for OAuth2 authorization code capture.
 *
 * **Mental model**
 *
 * - **Scope-owned lifecycle**: {@link startCallbackServer} returns a `codePromise`
 *   (Deferred). The server validates the CSRF `state` parameter, resolves the
 *   Deferred with the authorization code, and stops when its enclosing scope closes.
 * - **Port auto-discovery**: Tries default port 8585, increments on conflict.
 *
 * @internal
 */
import { OAuthError } from "@knpkv/atlassian-common/auth"
import * as Context from "effect/Context"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import { HttpRouter, HttpServer, HttpServerResponse } from "effect/unstable/http"
import type * as HttpServerError from "effect/unstable/http/HttpServerError"

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

export const callbackUrl = (port: number): string => `http://127.0.0.1:${port}/callback`

/**
 * Tag for the HttpServerFactory service.
 *
 * @category Services
 */
export class HttpServerFactoryTag extends Context.Service<
  HttpServerFactoryTag,
  HttpServerFactory
>()("@knpkv/jira-cli/HttpServerFactory") {}

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
    const serverScope = yield* Effect.scope
    const buildServerContext = (port: number): Effect.Effect<
      { readonly context: Context.Context<HttpServer.HttpServer>; readonly port: number },
      OAuthError
    > =>
      Layer.buildWithScope(factory.createServerLayer(callbackServerListenOptions(port)), serverScope).pipe(
        Effect.map((context) => ({ context, port })),
        Effect.catchIf(
          (error) => isAddressInUse(error) && port < MAX_PORT,
          () => buildServerContext(port + 1)
        ),
        Effect.mapError((cause) => new OAuthError({ step: "authorize", cause }))
      )
    const { context: serverContext } = yield* buildServerContext(DEFAULT_PORT)
    const server: HttpServerInstance = Context.get(serverContext, HttpServer.HttpServer)
    const port = yield* (server.address._tag === "TcpAddress"
      ? Effect.succeed(server.address.port)
      : Effect.fail(new OAuthError({ step: "authorize", cause: "OAuth callback server must listen on a TCP port" })))

    const router = yield* HttpRouter.make
    yield* router.add(
      "GET",
      "/callback",
      (req) =>
        Effect.gen(function*() {
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
              new OAuthError({ step: "authorize", cause: errorDescription ?? error })
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
    const app = router.asHttpEffect()

    yield* HttpServer.serveEffect(app).pipe(
      Effect.provide(serverContext),
      Effect.forkScoped
    )

    return {
      codePromise: Deferred.await(deferred),
      port
    }
  })
