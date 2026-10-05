/**
 * CodeCommit web's Owner Session: the shared `@knpkv/browser-pairing/owner-session` policy, with
 * writes.
 *
 * Requests are checked against the bound server's own origin. In development the Vite proxy rewrites
 * Origin to the backend before forwarding (see `tooling/authenticated-dev-proxy.ts`), so the dev
 * origin is only ever advertised, never accepted.
 *
 * @module
 */
import type { BrowserPairingError, CredentialCookieError } from "@knpkv/browser-pairing"
import * as OwnerSession from "@knpkv/browser-pairing/owner-session"
import { type Crypto, Effect, Layer, Redacted } from "effect"
import { ForbiddenApiError, OwnerSessionAuth, UnauthorizedApiError } from "../Api.js"

/** Build the session for a server bound at `authorityOrigin`. Rotate it on every bind attempt. */
export const makeOwnerSession = Effect.fn("CodeCommitWeb.makeOwnerSession")(
  function*(authorityOrigin: string): Effect.fn.Return<
    OwnerSession.OwnerSessionService,
    OwnerSession.UnsafeLoopbackAddressError | BrowserPairingError | CredentialCookieError,
    Crypto.Crypto
  > {
    return yield* OwnerSession.make({
      authorityOrigin,
      browserOrigin: authorityOrigin,
      cookieName: "cc_owner",
      freshUrlHint: "restart codecommit web for a fresh URL",
      product: "CodeCommit web",
      writes: "csrf"
    })
  }
)

export const ownerSessionAuthLayer = Layer.effect(
  OwnerSessionAuth,
  Effect.gen(function*() {
    const session = yield* OwnerSession.OwnerSession
    return OwnerSessionAuth.of({
      ownerCookie: Effect.fn("CodeCommitWeb.ownerCookie")(function*(httpEffect, { credential }) {
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
