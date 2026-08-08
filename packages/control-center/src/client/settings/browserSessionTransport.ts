import * as Effect from "effect/Effect"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"

import { makeControlCenterApiClient } from "../../api/client.js"
import type {
  BrowserPairingPermission,
  IssueBrowserPairingCodeResponse,
  SessionListResponse
} from "../../api/session.js"
import type { SessionId } from "../../domain/identifiers.js"
import { makeAuthenticatedMutationClient } from "../authenticatedMutationClient.js"

/** Browser boundary for owner-managed browser pairing and targeted session revocation. */
export interface BrowserSessionAdministrationTransport {
  readonly issuePairingCode: (
    permission: BrowserPairingPermission,
    signal: AbortSignal
  ) => Promise<IssueBrowserPairingCodeResponse>
  readonly list: (signal: AbortSignal) => Promise<SessionListResponse>
  readonly revoke: (sessionId: SessionId, signal: AbortSignal) => Promise<void>
}

/** Generated API transport for workspace-scoped browser session administration. */
export const browserSessionAdministrationTransport: BrowserSessionAdministrationTransport = {
  issuePairingCode: (permission, signal) =>
    Effect.runPromise(
      Effect.gen(function*() {
        const client = yield* makeAuthenticatedMutationClient
        return yield* client.session.issueBrowserPairingCode({ payload: { permission } })
      }).pipe(Effect.provide(FetchHttpClient.layer)),
      { signal }
    ),
  list: (signal) =>
    Effect.runPromise(
      Effect.gen(function*() {
        const client = yield* makeControlCenterApiClient()
        return yield* client.session.list()
      }).pipe(Effect.provide(FetchHttpClient.layer)),
      { signal }
    ),
  revoke: (sessionId, signal) =>
    Effect.runPromise(
      Effect.gen(function*() {
        const client = yield* makeAuthenticatedMutationClient
        yield* client.session.revoke({ params: { sessionId } })
      }).pipe(Effect.provide(FetchHttpClient.layer)),
      { signal }
    )
}
