import { Effect } from "effect"
import {
  ownerSessionOrigin,
  type OwnerSessionSecretsContract,
  ownerSessionUrlForOrigin,
  resolvePublicOrigin
} from "./OwnerSessionSecurity.js"

/** Resolve the advertised origin for one concrete server bind attempt. */
export const resolveCodeCommitPublicOrigin = Effect.fn("CodeCommitServer.resolvePublicOrigin")(
  function*(configuredOrigin: string | undefined, port: number) {
    return yield* resolvePublicOrigin(configuredOrigin, ownerSessionOrigin("127.0.0.1", port))
  }
)

/** Resolve the startup origin before constructing the token-bearing bootstrap URL. */
export const resolveCodeCommitBootstrapUrl = Effect.fn("CodeCommitServer.resolveBootstrapUrl")(
  function*(configuredOrigin: string | undefined, port: number, secrets: OwnerSessionSecretsContract) {
    const publicOrigin = yield* resolveCodeCommitPublicOrigin(configuredOrigin, port)
    return ownerSessionUrlForOrigin(publicOrigin, secrets)
  }
)

/** Keep a retrying backend off the stale Vite proxy port; advertise it directly. */
export const resolveCodeCommitBootstrapUrlForBind = Effect.fn("CodeCommitServer.resolveBootstrapUrlForBind")(
  function*(
    configuredOrigin: string | undefined,
    requestedPort: number,
    actualPort: number,
    secrets: OwnerSessionSecretsContract
  ) {
    const originOverride = requestedPort === actualPort ? configuredOrigin : undefined
    return yield* resolveCodeCommitBootstrapUrl(originOverride, actualPort, secrets)
  }
)
