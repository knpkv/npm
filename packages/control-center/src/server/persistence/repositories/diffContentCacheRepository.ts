import * as Context from "effect/Context"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import type { Success } from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"

import type { DiffFileAnchor } from "../../../api/diff.js"
import type { PluginConnectionId, WorkspaceId } from "../../../domain/identifiers.js"
import type { Revision, VendorImmutableId } from "../../../domain/sourceRevision.js"
import { UtcTimestamp } from "../../../domain/utcTimestamp.js"
import { Database } from "../Database.js"
import { PersistedRecordError } from "../errors.js"
import { mapPersistenceOperation } from "./internal.js"
import type { ContentBlobDigest } from "./models.js"
import { ContentBlobDigest as ContentBlobDigestSchema } from "./models.js"

/** Immutable identity of one cached side of one changed file. */
export interface DiffContentCacheKey {
  readonly workspaceId: WorkspaceId
  readonly pluginConnectionId: PluginConnectionId
  readonly vendorImmutableId: VendorImmutableId
  readonly revision: Revision
  readonly anchor: DiffFileAnchor
  readonly side: "before" | "after"
}

const CachedDigestRow = Schema.Struct({ digest: ContentBlobDigestSchema })

const makeDiffContentCacheRepository = Effect.gen(function*() {
  const { sql } = yield* Database

  const get = Effect.fn("DiffContentCacheRepository.get")(function*(key: DiffContentCacheKey) {
    const rows = yield* sql<Record<string, unknown>>`SELECT content_digest AS digest
      FROM diff_content_cache_entries
      WHERE workspace_id = ${key.workspaceId}
        AND plugin_connection_id = ${key.pluginConnectionId}
        AND vendor_immutable_id = ${key.vendorImmutableId}
        AND source_revision = ${key.revision}
        AND file_anchor = ${key.anchor}
        AND side = ${key.side}`.pipe(mapPersistenceOperation("diff-content-cache.get"))
    if (rows.length === 0) return Option.none<ContentBlobDigest>()
    const decoded = Schema.decodeUnknownResult(CachedDigestRow)(rows[0])
    if (Result.isSuccess(decoded)) return Option.some(decoded.success.digest)
    return yield* new PersistedRecordError({
      workspaceId: key.workspaceId,
      recordKind: "diff-content-cache",
      recordKey: key.anchor,
      diagnosticCode: "diff-content-cache-schema-invalid"
    })
  })

  return {
    get,
    put: Effect.fn("DiffContentCacheRepository.put")(function*(
      key: DiffContentCacheKey,
      digest: ContentBlobDigest
    ) {
      const cachedAt = yield* DateTime.now
      const encodedCachedAt = Schema.encodeSync(UtcTimestamp)(cachedAt)
      yield* sql`INSERT INTO diff_content_cache_entries (
          workspace_id, plugin_connection_id, vendor_immutable_id, source_revision,
          file_anchor, side, content_digest, cached_at
        ) VALUES (
          ${key.workspaceId}, ${key.pluginConnectionId}, ${key.vendorImmutableId}, ${key.revision},
          ${key.anchor}, ${key.side}, ${digest}, ${encodedCachedAt}
        )
        ON CONFLICT (
          workspace_id, plugin_connection_id, vendor_immutable_id, source_revision, file_anchor, side
        ) DO UPDATE SET
          content_digest = excluded.content_digest,
          cached_at = excluded.cached_at`.pipe(mapPersistenceOperation("diff-content-cache.put"))
    })
  }
})

/** Durable lookup from immutable diff identity to content-addressed bytes. */
export interface DiffContentCacheRepositoryService extends Success<typeof makeDiffContentCacheRepository> {}

/** Private repository for reproducible complete-diff cache entries. */
export class DiffContentCacheRepository extends Context.Service<
  DiffContentCacheRepository,
  DiffContentCacheRepositoryService
>()("@knpkv/control-center/server/persistence/DiffContentCacheRepository") {
  static readonly layer = Layer.effect(DiffContentCacheRepository, makeDiffContentCacheRepository)
}
