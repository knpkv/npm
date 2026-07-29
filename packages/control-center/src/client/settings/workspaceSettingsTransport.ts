import * as BrowserCrypto from "@effect/platform-browser/BrowserCrypto"
import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"

import { makeControlCenterApiClient } from "../../api/client.js"
import type { UpdateWorkspaceSettingsRequest, WorkspaceSettingsReadModel } from "../../api/workspaceSettings.js"
import { WorkspaceSettingsMutationId } from "../../domain/identifiers.js"
import { makeAuthenticatedMutationClient } from "../authenticatedMutationClient.js"

/** Browser boundary for authenticated settings reads and owner-authorized mutations. */
export interface WorkspaceSettingsTransport {
  readonly load: (signal: AbortSignal) => Promise<WorkspaceSettingsReadModel>
  readonly makeMutationId: () => Promise<WorkspaceSettingsMutationId>
  readonly update: (
    request: UpdateWorkspaceSettingsRequest,
    signal: AbortSignal
  ) => Promise<WorkspaceSettingsReadModel>
}

/** Generated API transport with a retry-stable UUIDv7 mutation identity. */
export const browserWorkspaceSettingsTransport: WorkspaceSettingsTransport = {
  load: (signal) =>
    Effect.runPromise(
      Effect.gen(function*() {
        const client = yield* makeControlCenterApiClient()
        return yield* client.workspaceSettings.read()
      }).pipe(Effect.provide(FetchHttpClient.layer)),
      { signal }
    ),
  makeMutationId: () =>
    Effect.runPromise(
      Effect.gen(function*() {
        const cryptoService = yield* Crypto.Crypto
        return yield* Schema.decodeUnknownEffect(
          WorkspaceSettingsMutationId
        )(yield* cryptoService.randomUUIDv7)
      }).pipe(Effect.provide(BrowserCrypto.layer))
    ),
  update: (request, signal) =>
    Effect.runPromise(
      Effect.gen(function*() {
        const client = yield* makeAuthenticatedMutationClient
        return yield* client.workspaceSettings.update({ payload: request })
      }).pipe(Effect.provide(FetchHttpClient.layer)),
      { signal }
    )
}
