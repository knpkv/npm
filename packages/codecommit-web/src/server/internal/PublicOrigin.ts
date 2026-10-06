import {
  loopbackOrigin,
  requireLoopbackOrigin,
  resolvePublicOrigin,
  UnsafeLoopbackAddressError
} from "@knpkv/browser-pairing/owner-session"
import { Effect } from "effect"

/** Resolve the advertised origin for one concrete server bind attempt. */
export const resolveCodeCommitPublicOrigin = Effect.fn("CodeCommitServer.resolvePublicOrigin")(
  function*(configuredOrigin: string | undefined, port: number) {
    return yield* resolvePublicOrigin(configuredOrigin, loopbackOrigin("127.0.0.1", port))
  }
)

/**
 * The origin to advertise for one bind attempt at `authorityOrigin`.
 *
 * A configured origin is either the server's own origin or the Vite dev proxy, which forwards to
 * `127.0.0.1:<proxyPort>` (its `PORT`). The proxy is advertised only when this bind is exactly that
 * backend. A bind on another host can never be reached through it, so that fails. A bind on another
 * port (a retry moved off a taken port, or `--port` differs from `PORT`) advertises its direct
 * origin instead and says so in the log, because a configured origin names the original port.
 * The configured value is always validated as a loopback origin.
 */
export const resolveCodeCommitPublicOriginForBind = Effect.fn("CodeCommitServer.resolvePublicOriginForBind")(
  function*(
    configuredOrigin: string | undefined,
    proxyPort: number,
    actualPort: number,
    authorityOrigin: string
  ) {
    // Canonical forms throughout: `http://localhost:3000/` and `:80` spellings name the same origin.
    const authority = yield* requireLoopbackOrigin(authorityOrigin)
    if (configuredOrigin === undefined) return authority
    const configured = yield* requireLoopbackOrigin(configuredOrigin)
    if (actualPort !== proxyPort) {
      // Moved off the configured port: whatever was configured named the old one.
      if (configured !== authority) {
        yield* Effect.logWarning(
          `Not advertising ${configured}: it targets port ${proxyPort}, this server is on ${actualPort}`
        )
      }
      return authority
    }
    const advertised = yield* resolvePublicOrigin(configured, authorityOrigin)
    if (advertised === authority) return authority
    const proxyHostBind = yield* requireLoopbackOrigin(loopbackOrigin("127.0.0.1", actualPort))
    if (authority !== proxyHostBind) {
      return yield* new UnsafeLoopbackAddressError({
        address: advertised,
        message: `The dev proxy forwards to 127.0.0.1; it cannot reach a server bound at ${authority}`
      })
    }
    return advertised
  }
)
