import * as OwnerSession from "@knpkv/browser-pairing/owner-session"
import { Effect, Layer, Redacted } from "effect"
import { Forbidden, OwnerAuth, Unauthorized } from "../api.js"

/** Fresh process session. Codes are minted only after the authenticated HTTP listener has built. */
export const makeOwnerSession = (origin: string) =>
  OwnerSession.make({
    product: "alchemy-console",
    cookieName: "alchemy_console_owner",
    writes: "none",
    freshUrlHint: "run `alchemy-console login` for a fresh URL",
    authorityOrigin: origin,
    browserOrigin: origin
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
    return OwnerAuth.of({
      ownerCookie: Effect.fn("AlchemyConsole.authorizeOwner")(function*(httpEffect, { credential }) {
        yield* session.authorizeHttp(Redacted.value(credential)).pipe(Effect.catchTags({
          OwnerSessionUnauthorizedError: () => Effect.fail(new Unauthorized({})),
          OwnerSessionForbiddenError: () => Effect.fail(new Forbidden({}))
        }))
        return yield* httpEffect
      })
    })
  })
)
