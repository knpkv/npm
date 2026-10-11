/**
 * Owner-only fresh sign-in links. The server-private bearer token lives in the 0600 control file;
 * cookie authentication and CORS do not apply here. The reply carries a one-time credential URL
 * on the same public origin as startup, never a session token or the control token.
 *
 * @module
 */
import { credentialValuesEqual } from "@knpkv/browser-pairing"
import * as OwnerSession from "@knpkv/browser-pairing/owner-session"
import { Effect, Option, Redacted } from "effect"
import { HttpMiddleware, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"

export const loginControlRouter = (token: Redacted.Redacted<string>, publicOrigin: string) =>
  HttpRouter.use((router) =>
    router.add(
      "POST",
      "/control/login",
      Effect.gen(function*() {
        const request = yield* HttpServerRequest.HttpServerRequest
        const header = request.headers.authorization
        if (
          header === undefined || !header.startsWith("Bearer ") ||
          !credentialValuesEqual(header.slice(7), Redacted.value(token))
        ) {
          return HttpServerResponse.empty({ status: 401, headers: { "cache-control": "no-store" } })
        }
        const session = yield* OwnerSession.OwnerSession
        const code = yield* session.mintBootstrapCode.pipe(Effect.orDie)
        return yield* HttpServerResponse.json(
          { url: OwnerSession.bootstrapUrl(publicOrigin, code) },
          { headers: { "cache-control": "no-store" } }
        )
      })
    )
  )

/** Keep ordinary CORS/preflight handling while excluding the bearer-only owner control route. */
export const controlAwareCors = (options: Parameters<typeof HttpRouter.cors>[0]) => {
  const cors = HttpMiddleware.cors(options)
  return HttpRouter.middleware((httpEffect) =>
    Effect.gen(function*() {
      const request = yield* HttpServerRequest.HttpServerRequest
      const url = HttpServerRequest.toURL(request)
      return yield* Option.isSome(url) && url.value.pathname === "/control/login" ? httpEffect : cors(httpEffect)
    }), { global: true })
}
