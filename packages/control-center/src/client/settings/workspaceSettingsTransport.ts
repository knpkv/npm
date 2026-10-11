import * as BrowserCrypto from "@effect/platform-browser/BrowserCrypto"
import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

import { makeControlCenterApiClient } from "../../api/client.js"
import type {
  UpdateWorkspaceSettingsRequest,
  WorkspacePresentationReadModel,
  WorkspaceSettingsReadModel
} from "../../api/workspaceSettings.js"
import { WorkspaceSettingsMutationId } from "../../domain/identifiers.js"
import type { ReleaseTargetCatalog } from "../../domain/releaseTargets.js"
import { makeAuthenticatedMutationClient } from "../authenticatedMutationClient.js"

/** Browser boundary for authenticated settings reads and owner-authorized mutations. */
export interface WorkspaceSettingsTransport {
  /** Test transports may omit the catalogue; the editor then reports it unavailable. */
  readonly loadTargetCatalog?: (signal: AbortSignal) => Promise<ReleaseTargetCatalog>
  readonly load: (signal: AbortSignal) => Promise<WorkspaceSettingsReadModel>
  readonly makeMutationId: () => Promise<WorkspaceSettingsMutationId>
  readonly update: (
    request: UpdateWorkspaceSettingsRequest,
    signal: AbortSignal
  ) => Promise<WorkspaceSettingsReadModel>
}

/** Browser boundary for collaborator-safe presentation defaults. */
export interface WorkspacePresentationTransport {
  readonly load: (signal: AbortSignal) => Promise<WorkspacePresentationReadModel>
}

/** Generated API transport exposing only shared presentation settings. */
export const browserWorkspacePresentationTransport: WorkspacePresentationTransport = {
  load: (signal) =>
    Effect.runPromise(
      Effect.gen(function*() {
        const client = yield* makeControlCenterApiClient()
        return yield* client.workspaceSettings.readPresentation()
      }).pipe(Effect.provide(FetchHttpClient.layer)),
      { signal }
    )
}

/** Request-scoped catalogue entry program; each run owns its HTTP layer lifetime. */
const targetCatalogueRead = Effect.scoped(Effect.gen(function*() {
  const context = yield* Layer.build(FetchHttpClient.layer)
  const client = yield* makeControlCenterApiClient().pipe(Effect.provideContext(context))
  return yield* client.workspaceSettings.releaseTargetCatalog()
}))

/** Generated API transport with a retry-stable UUIDv7 mutation identity. */
export const browserWorkspaceSettingsTransport: WorkspaceSettingsTransport = {
  loadTargetCatalog: (signal) => Effect.runPromise(targetCatalogueRead, { signal }),
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
