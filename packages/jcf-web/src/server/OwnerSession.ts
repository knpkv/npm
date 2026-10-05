/**
 * jcf-web's Owner Session: the shared `@knpkv/browser-pairing/owner-session` policy, with writes.
 *
 * The page saves timesheet entries, so writes need the CSRF token the bootstrap exchange returns. The
 * Vite dev server keeps its own Origin when it proxies, so the configured public origin is also the
 * origin every browser request is checked against: the URL that gets printed cannot be advertised and
 * then rejected.
 *
 * @module
 */
import type { BrowserPairingError, CredentialCookieError } from "@knpkv/browser-pairing"
import * as OwnerSession from "@knpkv/browser-pairing/owner-session"
import { type Crypto, Effect, Layer, Redacted } from "effect"
import { ForbiddenApiError, OwnerSessionAuth, UnauthorizedApiError } from "./Api.js"

/** Build the session for a server bound at `authorityOrigin`, advertised at `configuredPublicOrigin`. */
export const makeOwnerSession = Effect.fn("JcfWeb.makeOwnerSession")(
  function*(
    authorityOrigin: string,
    configuredPublicOrigin?: string
  ): Effect.fn.Return<
    OwnerSession.OwnerSessionService,
    OwnerSession.UnsafeLoopbackAddressError | BrowserPairingError | CredentialCookieError,
    Crypto.Crypto
  > {
    return yield* OwnerSession.make({
      authorityOrigin,
      browserOrigin: yield* OwnerSession.resolvePublicOrigin(configuredPublicOrigin, authorityOrigin),
      cookieName: "jcf_owner",
      freshUrlHint: "restart jcf-web for a fresh URL",
      product: "jcf-web",
      writes: "csrf"
    })
  }
)

export const ownerSessionAuthLayer = Layer.effect(
  OwnerSessionAuth,
  Effect.gen(function*() {
    const session = yield* OwnerSession.OwnerSession
    return OwnerSessionAuth.of({
      ownerCookie: Effect.fn("JcfWeb.ownerCookie")(function*(httpEffect, { credential }) {
        yield* session.authorizeHttp(Redacted.value(credential)).pipe(
          Effect.catchTags({
            OwnerSessionForbiddenError: ({ message }) => Effect.fail(new ForbiddenApiError({ message })),
            OwnerSessionUnauthorizedError: ({ message }) => Effect.fail(new UnauthorizedApiError({ message }))
          })
        )
        return yield* httpEffect
      })
    })
  })
)
