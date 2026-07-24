import * as Context from "effect/Context"
import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Encoding from "effect/Encoding"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"

import {
  type CompleteDiffContentRange,
  type CompleteDiffInventory,
  type CompleteDiffInventoryEntry,
  DiffFileAnchor
} from "../../api/diff.js"
import type { PluginConnectionId, WorkspaceId } from "../../domain/identifiers.js"
import {
  type DiffInventoryPageV1,
  PluginEntityReferenceV1,
  PluginEntityType,
  type PluginPageCursorV1
} from "../../domain/plugins/events.js"
import { Revision, type VendorImmutableId } from "../../domain/sourceRevision.js"
import {
  ApplicationConflict,
  ApplicationRateLimited,
  ApplicationResourceNotFound,
  ApplicationServiceUnavailable,
  type CompleteDiffReadError,
  CompleteDiffReads
} from "../api/ApplicationServices.js"
import { Persistence, type PersistenceService } from "../persistence/Persistence.js"
import { type PluginFailure, PluginOutageFailure, PluginUnsupportedCapabilityFailure } from "../plugins/failures.js"
import { PluginConnection } from "../plugins/PluginConnection.js"
import type { PluginConnectionMapV1 } from "../plugins/PluginConnectionMap.js"
import { mapPersistenceRead } from "./errors.js"

const MaximumFiles = 500
const MaximumPages = 100

interface DiffScope {
  readonly workspaceId: WorkspaceId
  readonly pluginConnectionId: PluginConnectionId
  readonly vendorImmutableId: VendorImmutableId
  readonly revision: Revision
}

interface ImmutableDiffRevisions {
  readonly revision: Revision
  readonly baseRevision: Revision
  readonly headRevision: Revision
}

type DiffRevisionLookup = (
  scope: DiffScope
) => Effect.Effect<ImmutableDiffRevisions, CompleteDiffReadError>

const makeDiffRevisionLookup = (persistence: PersistenceService): DiffRevisionLookup =>
  Effect.fn("CompleteDiffReads.lookupRevision")(function*(scope) {
    const result = yield* mapPersistenceRead(persistence.deliveryGraph.read(scope.workspaceId, {
      _tag: "sourceEntityProjection",
      pluginConnectionId: scope.pluginConnectionId,
      providerId: "codecommit",
      vendorImmutableId: scope.vendorImmutableId,
      revision: scope.revision
    }))
    if (result._tag !== "sourceEntityProjection") return yield* new ApplicationConflict()
    const { projection, sourceRevision } = result.value
    if (
      sourceRevision !== scope.revision ||
      projection.entityState !== "present" ||
      projection.details._tag !== "pull-request" ||
      projection.details.baseRevision === undefined ||
      projection.details.baseRevision === null
    ) {
      return yield* new ApplicationConflict()
    }
    return {
      revision: sourceRevision,
      baseRevision: Revision.make(projection.details.baseRevision),
      headRevision: Revision.make(projection.details.headRevision)
    }
  })

const unavailable = (): ApplicationServiceUnavailable => new ApplicationServiceUnavailable({ retryAt: null })

const mapPluginFailure = (failure: PluginFailure): CompleteDiffReadError => {
  switch (failure._tag) {
    case "PluginConflictFailure":
      return new ApplicationConflict()
    case "PluginRateLimitFailure":
      return new ApplicationRateLimited({ retryAt: failure.retryAt })
    case "PluginConfigurationFailure":
      return failure.diagnosticCode === "codecommit-provider-object-not-found"
        ? new ApplicationResourceNotFound()
        : unavailable()
    case "PluginAuthenticationFailure":
    case "PluginAuthorizationFailure":
    case "PluginCancellationFailure":
    case "PluginMalformedResponseFailure":
    case "PluginOutageFailure":
    case "PluginTimeoutFailure":
    case "PluginUnknownOutcomeFailure":
    case "PluginUnsupportedCapabilityFailure":
      return unavailable()
  }
}

const entityReference = ({ vendorImmutableId }: DiffScope) =>
  PluginEntityReferenceV1.make({
    entityType: PluginEntityType.make("pull-request"),
    vendorImmutableId
  })

const anchorFor = Effect.fn("CompleteDiffReads.anchorFor")(function*(
  cryptoService: Crypto.Crypto,
  revision: Revision,
  entry: Pick<CompleteDiffInventoryEntry, "path" | "previousPath" | "status">
) {
  const material = JSON.stringify([revision, entry.status, entry.previousPath, entry.path])
  const digest = yield* cryptoService.digest("SHA-256", new TextEncoder().encode(material)).pipe(
    Effect.mapError(() => new PluginOutageFailure({ operation: "complete-diff-anchor-digest" }))
  )
  return DiffFileAnchor.make(`sha256:${Encoding.encodeHex(digest)}`)
})

const withConnection = <A>(
  pluginConnections: PluginConnectionMapV1,
  scope: Pick<DiffScope, "workspaceId" | "pluginConnectionId">,
  use: (connection: PluginConnection["Service"]) => Effect.Effect<A, PluginFailure>
): Effect.Effect<A, CompleteDiffReadError> =>
  Effect.scoped(
    Effect.gen(function*() {
      const context = yield* pluginConnections.contextEffect({
        workspaceId: scope.workspaceId,
        pluginConnectionId: scope.pluginConnectionId
      })
      const connection = Context.get(context, PluginConnection)
      return yield* use(connection)
    })
  ).pipe(Effect.mapError(mapPluginFailure))

const unsupported = (capabilityId: "diff.inventory" | "diff.content") =>
  new PluginUnsupportedCapabilityFailure({
    capabilityId,
    requestedVersion: 2,
    diagnosticCode: "complete-diff-capability-unavailable"
  })

/** Build complete bounded diff reads over the same lazy scoped plugin registry as synchronization. */
export const makeCompleteDiffReads = (
  pluginConnections: PluginConnectionMapV1 | null,
  cryptoService: Crypto.Crypto,
  lookupRevision: DiffRevisionLookup
): CompleteDiffReads["Service"] => ({
  inventory: Effect.fn("CompleteDiffReads.inventory")(function*(scope) {
    if (pluginConnections === null) return yield* unavailable()
    const immutable = yield* lookupRevision(scope)
    return yield* withConnection(pluginConnections, scope, (connection) =>
      Option.match(connection.diff, {
        onNone: () => Effect.fail(unsupported("diff.inventory")),
        onSome: (diff) => {
          const readInventoryPageV2 = diff.readInventoryPageV2
          return readInventoryPageV2 === undefined
            ? Effect.fail(unsupported("diff.inventory"))
            : Effect.gen(function*() {
              const entries: Array<CompleteDiffInventoryEntry> = []
              const seenCursors = new Set<string>()
              let cursor: PluginPageCursorV1 | null = null
              for (let pageNumber = 0; pageNumber < MaximumPages; pageNumber++) {
                const page: DiffInventoryPageV1 = yield* readInventoryPageV2({
                  entity: entityReference(scope),
                  expectedRevision: immutable.revision,
                  baseRevision: immutable.baseRevision,
                  headRevision: immutable.headRevision,
                  cursor
                })
                for (const entry of page.entries) {
                  if (entries.length >= MaximumFiles) {
                    return yield* new PluginOutageFailure({ operation: "complete-diff-file-limit" })
                  }
                  const anchor = yield* anchorFor(cryptoService, scope.revision, entry)
                  entries.push({ ...entry, anchor })
                }
                if (page.nextCursor === null) {
                  return { entries, ready: true } satisfies CompleteDiffInventory
                }
                if (seenCursors.has(page.nextCursor)) {
                  return yield* new PluginOutageFailure({ operation: "complete-diff-cursor-cycle" })
                }
                seenCursors.add(page.nextCursor)
                cursor = page.nextCursor
              }
              return yield* new PluginOutageFailure({ operation: "complete-diff-page-limit" })
            })
        }
      }))
  }),
  content: Effect.fn("CompleteDiffReads.content")(function*(scope) {
    if (pluginConnections === null) return yield* unavailable()
    const immutable = yield* lookupRevision(scope)
    const expectedAnchor = yield* anchorFor(cryptoService, scope.revision, scope).pipe(
      Effect.mapError(mapPluginFailure)
    )
    if (expectedAnchor !== scope.anchor) return yield* new ApplicationConflict()
    return yield* withConnection(pluginConnections, scope, (connection) =>
      Option.match(connection.diff, {
        onNone: () => Effect.fail(unsupported("diff.content")),
        onSome: (diff) =>
          diff.readContentRangeV2 === undefined
            ? Effect.fail(unsupported("diff.content"))
            : diff
              .readContentRangeV2({
                entity: entityReference(scope),
                expectedRevision: immutable.revision,
                baseRevision: immutable.baseRevision,
                headRevision: immutable.headRevision,
                path: scope.path,
                previousPath: scope.previousPath,
                status: scope.status,
                side: scope.side,
                offset: scope.offset,
                length: scope.length
              })
              .pipe(Effect.map((content) => content satisfies CompleteDiffContentRange))
      }))
  })
})

/** Complete-diff read layer for a configured scoped provider registry. */
export const completeDiffReadsLayer = (
  pluginConnections: PluginConnectionMapV1 | null
): Layer.Layer<CompleteDiffReads, never, Crypto.Crypto | Persistence> =>
  Layer.effect(
    CompleteDiffReads,
    Effect.gen(function*() {
      const cryptoService = yield* Crypto.Crypto
      const persistence = yield* Persistence
      return makeCompleteDiffReads(pluginConnections, cryptoService, makeDiffRevisionLookup(persistence))
    })
  )
