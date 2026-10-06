import { loopbackOrigin, resolvePublicOrigin } from "@knpkv/browser-pairing/owner-session"
import { Effect } from "effect"

/** Resolve the advertised origin for one concrete server bind attempt. */
export const resolveCodeCommitPublicOrigin = Effect.fn("CodeCommitServer.resolvePublicOrigin")(
  function*(configuredOrigin: string | undefined, port: number) {
    return yield* resolvePublicOrigin(configuredOrigin, loopbackOrigin("127.0.0.1", port))
  }
)

/**
 * The origin to advertise for one bind attempt at `authorityOrigin`. A retrying backend has moved
 * off the port the Vite proxy forwards to, so it advertises itself directly instead.
 */
export const resolveCodeCommitPublicOriginForBind = Effect.fn("CodeCommitServer.resolvePublicOriginForBind")(
  function*(
    configuredOrigin: string | undefined,
    requestedPort: number,
    actualPort: number,
    authorityOrigin: string
  ) {
    const originOverride = requestedPort === actualPort ? configuredOrigin : undefined
    return yield* resolvePublicOrigin(originOverride, authorityOrigin)
  }
)
