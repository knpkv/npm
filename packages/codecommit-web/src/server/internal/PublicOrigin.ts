import { loopbackOrigin, resolvePublicOrigin } from "@knpkv/browser-pairing/owner-session"
import { Effect } from "effect"

/** Resolve the advertised origin for one concrete server bind attempt. */
export const resolveCodeCommitPublicOrigin = Effect.fn("CodeCommitServer.resolvePublicOrigin")(
  function*(configuredOrigin: string | undefined, port: number) {
    return yield* resolvePublicOrigin(configuredOrigin, loopbackOrigin("127.0.0.1", port))
  }
)

/** Keep a retrying backend off the stale Vite proxy port; advertise it directly. */
export const resolveCodeCommitPublicOriginForBind = Effect.fn("CodeCommitServer.resolvePublicOriginForBind")(
  function*(configuredOrigin: string | undefined, requestedPort: number, actualPort: number) {
    const originOverride = requestedPort === actualPort ? configuredOrigin : undefined
    return yield* resolveCodeCommitPublicOrigin(originOverride, actualPort)
  }
)
