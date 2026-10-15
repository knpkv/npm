import * as OwnerSession from "@knpkv/browser-pairing/owner-session"
import { Effect, Layer } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { HttpApiBuilder } from "effect/http-api"
import { AlchemyConsoleApi } from "../api.js"
import { BootstrapRoutes } from "./Bootstrap.js"
import { Catalog } from "./Catalog.js"
import { ownerAuthLayer } from "./OwnerSession.js"
import { PlanReader } from "./PlanReader.js"

const handlers = HttpApiBuilder.group(AlchemyConsoleApi, "stacks", (handlers) =>
  Effect.gen(function*() {
    const catalog = yield* Catalog
    const plans = yield* PlanReader
    return handlers.handle("list", () => catalog.list).handle("get", ({ params }) => catalog.get(params.id)).handle(
      "plan",
      ({ params }) => catalog.identify(params.id).pipe(Effect.flatMap((stack) => plans.read(stack.app, stack.stage)))
    )
  }))

/** Refuse unsafe/unmatched API requests before handlers; even refusals and missing routes cannot be cached. */
const boundary = Layer.unwrap(Effect.gen(function*() {
  const session = yield* OwnerSession.OwnerSession
  const host = new URL(session.authorityOrigin).host
  return HttpRouter.middleware((httpEffect) =>
    Effect.gen(function*() {
      const request = yield* HttpServerRequest.HttpServerRequest
      if (request.headers.host !== host) return HttpServerResponse.empty({ status: 403 })
      if (!URL.canParse(request.url, session.authorityOrigin)) return HttpServerResponse.empty({ status: 400 })
      const url = new URL(request.url, session.authorityOrigin)
      if (url.origin !== session.authorityOrigin) return HttpServerResponse.empty({ status: 403 })
      const pathname = url.pathname
      if (pathname === "/api" || pathname.startsWith("/api/")) {
        const authorized = yield* Effect.result(session.authorizeHttp(request.cookies[session.cookieName] ?? ""))
        if (authorized._tag === "Failure") {
          return HttpServerResponse.empty({
            status: authorized.failure._tag === "OwnerSessionUnauthorizedError" ? 401 : 403
          })
        }
      }
      return yield* httpEffect
    }).pipe(Effect.map((response) =>
      response.pipe(HttpServerResponse.setHeaders({
        "cache-control": "private, no-store",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
        "x-frame-options": "DENY",
        "content-security-policy":
          "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"
      }))
    )), { global: true })
}))

/** Listener, source readers and owner session belong to the executable's runtime layer. */
export const application = Layer.mergeAll(
  HttpApiBuilder.layer(AlchemyConsoleApi).pipe(Layer.provide(handlers), Layer.provide(ownerAuthLayer)),
  OwnerSession.BootstrapRouter,
  BootstrapRoutes,
  boundary
)
