import * as Context from "effect/Context"
import * as Crypto from "effect/Crypto"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Encoding from "effect/Encoding"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Result from "effect/Result"

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
const MaximumContentBytes = 1_048_576

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
  headRevision: Revision,
  entry: Pick<CompleteDiffInventoryEntry, "path" | "previousPath">
) {
  const material = JSON.stringify([headRevision, entry.previousPath, entry.path])
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

type ContentScope = Parameters<CompleteDiffReads["Service"]["content"]>[0]
/** Narrow cache boundary accepted by the complete-diff application service. */
export interface DiffContentCachePersistence {
  readonly content: Pick<PersistenceService["content"], "readAll">
  readonly diffContentCache: Pick<
    PersistenceService["diffContentCache"],
    "get" | "putContent"
  >
}

const cacheKey = (scope: ContentScope) => ({
  workspaceId: scope.workspaceId,
  pluginConnectionId: scope.pluginConnectionId,
  vendorImmutableId: scope.vendorImmutableId,
  revision: scope.revision,
  anchor: scope.anchor,
  status: scope.status,
  side: scope.side
})

const sliceContent = (
  bytes: Uint8Array,
  offset: number,
  length: number
): CompleteDiffContentRange => {
  const start = Math.min(offset, bytes.byteLength)
  const end = Math.min(bytes.byteLength, start + length)
  return {
    bytesBase64: Encoding.encodeBase64(bytes.slice(start, end)),
    totalBytes: bytes.byteLength,
    unavailableReason: null
  }
}

const readCachedContent = Effect.fn("CompleteDiffReads.readCachedContent")(function*(
  persistence: DiffContentCachePersistence,
  scope: ContentScope
) {
  const digestRead = yield* persistence.diffContentCache.get(cacheKey(scope)).pipe(Effect.result)
  if (Result.isFailure(digestRead)) return Option.none<CompleteDiffContentRange>()
  const digest = digestRead.success
  if (Option.isNone(digest)) return Option.none<CompleteDiffContentRange>()
  const attempted = yield* persistence.content.readAll(
    scope.workspaceId,
    digest.value,
    MaximumContentBytes
  ).pipe(Effect.result)
  if (Result.isFailure(attempted)) return Option.none<CompleteDiffContentRange>()
  return Option.some(sliceContent(attempted.success, scope.offset, scope.length))
})

const rememberContent = Effect.fn("CompleteDiffReads.rememberContent")(function*(
  persistence: DiffContentCachePersistence,
  scope: ContentScope,
  bytes: Uint8Array
) {
  yield* persistence.diffContentCache.putContent(cacheKey(scope), {
    bytes,
    classification: "reproducible-cache",
    mimeType: "text/plain; charset=utf-8",
    createdAt: yield* DateTime.now
  }).pipe(Effect.mapError(() => unavailable()))
})

/** Build complete bounded diff reads over the same lazy scoped plugin registry as synchronization. */
export const makeCompleteDiffReads = (
  pluginConnections: PluginConnectionMapV1 | null,
  cryptoService: Crypto.Crypto,
  lookupRevision: DiffRevisionLookup,
  persistence?: DiffContentCachePersistence
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
                  const anchor = yield* anchorFor(cryptoService, immutable.headRevision, entry)
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
    const expectedAnchor = yield* anchorFor(cryptoService, immutable.headRevision, scope).pipe(
      Effect.mapError(mapPluginFailure)
    )
    if (expectedAnchor !== scope.anchor) return yield* new ApplicationConflict()
    if (persistence !== undefined) {
      const cached = yield* readCachedContent(persistence, scope)
      if (Option.isSome(cached)) return cached.value
    }
    const content = yield* withConnection(pluginConnections, scope, (connection) =>
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
                offset: 0,
                length: MaximumContentBytes
              })
              .pipe(Effect.map((content) => content satisfies CompleteDiffContentRange))
      }))
    if (content.unavailableReason !== null || content.bytesBase64 === null) return content
    const bytes = yield* Effect.fromResult(Encoding.decodeBase64(content.bytesBase64)).pipe(
      Effect.mapError(() => unavailable())
    )
    if (content.totalBytes !== bytes.byteLength || bytes.byteLength > MaximumContentBytes) {
      return yield* unavailable()
    }
    if (persistence !== undefined) yield* rememberContent(persistence, scope, bytes).pipe(Effect.ignore)
    return sliceContent(bytes, scope.offset, scope.length)
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
      return makeCompleteDiffReads(
        pluginConnections,
        cryptoService,
        makeDiffRevisionLookup(persistence),
        persistence
      )
    })
  )
