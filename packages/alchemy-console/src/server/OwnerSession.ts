import * as OwnerSession from "@knpkv/browser-pairing/owner-session"
import { Effect, Layer } from "effect"
import { HttpServerRequest } from "effect/http"
import { Forbidden, OwnerAuth, Unauthorized } from "../api.js"

/** Fresh process session. Codes are minted only after the authenticated HTTP listener has built. */
export const makeOwnerSession = (port: number) =>
  OwnerSession.make({
    product: "alchemy-console",
    cookieName: `alchemy_console_owner_${port}`,
    writes: "none",
    freshUrlHint: "run `alchemy-console login` for a fresh URL",
    authorityOrigin: OwnerSession.loopbackOrigin("127.0.0.1", port),
    browserOrigin: OwnerSession.loopbackOrigin("127.0.0.1", port)
  })

/** Credential-bearing URL. Stdout and browser launch are its only announcement boundaries. */
export const mintBootstrapUrl = (session: OwnerSession.OwnerSessionService) =>
  session.mintBootstrapCode.pipe(
    Effect.map((code) => OwnerSession.bootstrapUrl(session.browserOrigin, code))
  )

export const ownerAuthLayer = Layer.effect(
  OwnerAuth,
  Effect.gen(function*() {
    const session = yield* OwnerSession.OwnerSession
    return OwnerAuth.of(
      Effect.fn("AlchemyConsole.authorizeOwner")(function*(httpEffect) {
        const request = yield* HttpServerRequest.HttpServerRequest
        yield* session.authorizeHttp(request.cookies[session.cookieName] ?? "").pipe(Effect.catchTags({
          OwnerSessionUnauthorizedError: () => Effect.fail(new Unauthorized({})),
          OwnerSessionForbiddenError: () => Effect.fail(new Forbidden({}))
        }))
        return yield* httpEffect
      })
    )
  })
)
