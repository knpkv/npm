import * as Effect from "effect/Effect"
import * as Option from "effect/Option"

import type { PluginConnectionId, WorkspaceId } from "../../domain/identifiers.js"
import type { ProviderId } from "../../domain/sourceRevision.js"
import type { PersistenceOperationFailure, PersistenceService } from "../persistence/Persistence.js"
import type { PluginConnectionRecord } from "../persistence/repositories/models.js"
import { PluginConflictFailure } from "../plugins/failures.js"

/** Exact mutable host state that authorized one manual synchronization runtime. */
export interface PluginSynchronizationAuthority {
  readonly workspaceId: WorkspaceId
  readonly pluginConnectionId: PluginConnectionId
  readonly providerId: ProviderId
  readonly connectionRevision: number
  readonly configurationRevision: number | null
}

const conflict = () =>
  new PluginConflictFailure({
    operation: "manual-sync",
    diagnosticCode: "manual-sync-runtime-authority-changed"
  })

const authorityFor = Effect.fn("PluginSynchronizationAuthority.forConnection")(function*(
  persistence: PersistenceService,
  connection: PluginConnectionRecord
) {
  const configuration = yield* persistence.pluginConfigurations.get(
    connection.workspaceId,
    connection.pluginConnectionId
  )
  return {
    workspaceId: connection.workspaceId,
    pluginConnectionId: connection.pluginConnectionId,
    providerId: connection.providerId,
    connectionRevision: connection.revision,
    configurationRevision: Option.isSome(configuration) ? configuration.value.revision : null
  } satisfies PluginSynchronizationAuthority
})

/** Capture connection and configuration revisions in one durable read transaction. */
export const capturePluginSynchronizationAuthority = Effect.fn(
  "PluginSynchronizationAuthority.capture"
)(function*(
  persistence: PersistenceService,
  workspaceId: WorkspaceId,
  pluginConnectionId: PluginConnectionId
): Effect.fn.Return<
  { readonly connection: PluginConnectionRecord; readonly authority: PluginSynchronizationAuthority },
  PersistenceOperationFailure
> {
  return yield* persistence.transact(Effect.gen(function*() {
    const connection = yield* persistence.pluginConnections.get(workspaceId, pluginConnectionId)
    const authority = yield* authorityFor(persistence, connection)
    return { connection, authority }
  }))
})

/** Reject a write transaction when its runtime no longer owns current connection authority. */
export const verifyPluginSynchronizationAuthority = Effect.fn(
  "PluginSynchronizationAuthority.verify"
)(function*(
  persistence: PersistenceService,
  expected: PluginSynchronizationAuthority
): Effect.fn.Return<void, PluginConflictFailure | PersistenceOperationFailure> {
  const connection = yield* persistence.pluginConnections.get(
    expected.workspaceId,
    expected.pluginConnectionId
  ).pipe(
    Effect.catchTag("RecordNotFoundError", () => conflict())
  )
  const current = yield* authorityFor(persistence, connection)
  if (
    !connection.isEnabled ||
    current.providerId !== expected.providerId ||
    current.connectionRevision !== expected.connectionRevision ||
    current.configurationRevision !== expected.configurationRevision
  ) {
    return yield* conflict()
  }
})
