/**
 * Local HTTP server for OAuth callback.
 *
 * @module
 */
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer"
import * as HttpRouter from "@effect/platform/HttpRouter"
import * as HttpServer from "@effect/platform/HttpServer"
import * as HttpServerRequest from "@effect/platform/HttpServerRequest"
import * as HttpServerResponse from "@effect/platform/HttpServerResponse"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as http from "node:http"
import { OAuthError } from "../ConfluenceError.js"

const CALLBACK_PORT = 8585

/**
 * Result from the OAuth callback server.
 */
export interface CallbackServerResult {
  /** Promise that resolves with the authorization code */
  readonly codePromise: Effect.Effect<string, OAuthError>
  /** Shutdown the callback server */
  readonly shutdown: Effect.Effect<void, never>
}

/**
 * Start a local HTTP server to receive OAuth callback.
 *
 * @param expectedState - The state parameter to verify against CSRF
 * @returns Server control interface with code promise and shutdown
 *
 * @category OAuth
 */
export const startCallbackServer = (
  expectedState: string
): Effect.Effect<CallbackServerResult, OAuthError> =>
  Effect.gen(function*() {
    const deferred = yield* Deferred.make<string, OAuthError>()

    const app = HttpRouter.empty.pipe(
      HttpRouter.get(
        "/callback",
        Effect.gen(function*() {
          const req = yield* HttpServerRequest.HttpServerRequest
          const url = new URL(req.url, `http://localhost:${CALLBACK_PORT}`)
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

    const server = http.createServer()
    const serverLayer = NodeHttpServer.layer(() => server, { port: CALLBACK_PORT })

    const serverFiber = yield* HttpServer.serve(app).pipe(
      Layer.provide(serverLayer),
      Layer.launch,
      Effect.fork
    )

    // Wait for server to be ready
    yield* Effect.promise(
      () =>
        new Promise<void>((resolve) => {
          if (server.listening) {
            resolve()
          } else {
            server.once("listening", () => resolve())
          }
        })
    )

    return {
      codePromise: Deferred.await(deferred),
      shutdown: Effect.gen(function*() {
        yield* Fiber.interrupt(serverFiber)
        yield* Effect.promise(
          () =>
            new Promise<void>((resolve) => {
              server.close(() => resolve())
            })
        )
      })
    }
  })
