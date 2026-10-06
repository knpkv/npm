import { loopbackOrigin, resolvePublicOrigin, UnsafeLoopbackAddressError } from "@knpkv/browser-pairing/owner-session"
import { Effect } from "effect"

/** Resolve the advertised origin for one concrete server bind attempt. */
export const resolveCodeCommitPublicOrigin = Effect.fn("CodeCommitServer.resolvePublicOrigin")(
  function*(configuredOrigin: string | undefined, port: number) {
    return yield* resolvePublicOrigin(configuredOrigin, loopbackOrigin("127.0.0.1", port))
  }
)

/**
 * The origin to advertise for one bind attempt at `authorityOrigin`. A retrying backend has moved
 * off the port the Vite proxy forwards to, so it advertises itself directly instead. The proxy
 * forwards to `127.0.0.1` only, so a configured proxy origin for any other bind host fails.
 */
export const resolveCodeCommitPublicOriginForBind = Effect.fn("CodeCommitServer.resolvePublicOriginForBind")(
  function*(
    configuredOrigin: string | undefined,
    requestedPort: number,
    actualPort: number,
    authorityOrigin: string
  ) {
    const originOverride = requestedPort === actualPort ? configuredOrigin : undefined
    const proxyTarget = loopbackOrigin("127.0.0.1", actualPort)
    if (originOverride !== undefined && originOverride !== authorityOrigin && authorityOrigin !== proxyTarget) {
      return yield* new UnsafeLoopbackAddressError({
        address: originOverride,
        message: `The dev proxy forwards to ${proxyTarget}; it cannot reach a server bound at ${authorityOrigin}`
      })
    }
    return yield* resolvePublicOrigin(originOverride, authorityOrigin)
  }
)
