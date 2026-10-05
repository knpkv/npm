/**
 * agent-usage's Owner Session: the shared `@knpkv/browser-pairing/owner-session` policy, read-only.
 *
 * The page shows the owner's agents' usage, ticket keys and working directories, and every route only
 * reads, so no CSRF token is issued and every unsafe method is refused. A bootstrap code is minted
 * when the server starts and another each time `agent-usage login` asks over the control socket; both
 * go through {@link mintBootstrapUrl}, and a newer code replaces an unspent one.
 *
 * @module
 */
import type { BrowserPairingError } from "@knpkv/browser-pairing"
import * as OwnerSession from "@knpkv/browser-pairing/owner-session"
import { type Crypto, Effect, Layer, Redacted } from "effect"
import { ForbiddenApiError, OwnerSessionAuth, UnauthorizedApiError } from "./Api.js"

/** Build the session for a server bound at `authorityOrigin`, advertised at `configuredPublicOrigin`. */
export const makeOwnerSession = Effect.fn("AgentUsage.makeOwnerSession")(
  function*(
    authorityOrigin: string,
    configuredPublicOrigin?: string
  ): Effect.fn.Return<
    OwnerSession.OwnerSessionService,
    OwnerSession.UnsafeLoopbackAddressError | BrowserPairingError,
    Crypto.Crypto
  > {
    return yield* OwnerSession.make({
      authorityOrigin,
      browserOrigin: yield* OwnerSession.resolvePublicOrigin(configuredPublicOrigin, authorityOrigin),
      cookieName: "agent_usage_owner",
      freshUrlHint: "run `agent-usage login` for a fresh URL",
      product: "agent-usage",
      writes: "none"
    })
  }
)

/**
 * Mints a fresh one-time code and returns the URL that carries it. The startup link and every
 * `agent-usage login` link come from here. Call it only once the server is listening.
 */
export const mintBootstrapUrl = (session: OwnerSession.OwnerSessionService) =>
  Effect.map(session.mintBootstrapCode, (code) => OwnerSession.bootstrapUrl(session.browserOrigin, code))

export const ownerSessionAuthLayer = Layer.effect(
  OwnerSessionAuth,
  Effect.gen(function*() {
    const session = yield* OwnerSession.OwnerSession
    return OwnerSessionAuth.of({
      ownerCookie: Effect.fn("AgentUsage.ownerCookie")(function*(httpEffect, { credential }) {
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
