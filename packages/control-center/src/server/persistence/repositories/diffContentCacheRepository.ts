import * as Context from "effect/Context"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import type { Success } from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"

import type { CompleteDiffInventoryEntry, DiffFileAnchor } from "../../../api/diff.js"
import { type PluginConnectionId, WorkspaceId } from "../../../domain/identifiers.js"
import type { Revision, VendorImmutableId } from "../../../domain/sourceRevision.js"
import { UtcTimestamp } from "../../../domain/utcTimestamp.js"
import { Database } from "../Database.js"
import { PersistedRecordError } from "../errors.js"
import { mapPersistenceOperation } from "./internal.js"
import type { ContentBlobDigest } from "./models.js"
import { ContentBlobDigest as ContentBlobDigestSchema } from "./models.js"
import type { SqlRow } from "./sqlRow.js"

/** Per-workspace hard cap; each entry represents at most one MiB of reproducible bytes. */
export const MaximumDiffContentCacheEntriesPerWorkspace = 2_000
/** Maximum number of persistent cleanup intents processed by one sweep. */
export const MaximumDiffContentCacheCleanupBatch = 64

/** Immutable identity of one cached side of one changed file. */
export interface DiffContentCacheKey {
  readonly workspaceId: WorkspaceId
  readonly pluginConnectionId: PluginConnectionId
  readonly vendorImmutableId: VendorImmutableId
  readonly revision: Revision
  readonly anchor: DiffFileAnchor
  readonly status: CompleteDiffInventoryEntry["status"]
  readonly side: "before" | "after"
}

const CachedDigestRow = Schema.Struct({ digest: ContentBlobDigestSchema })
const CleanupCandidateRow = Schema.Struct({
  workspaceId: WorkspaceId,
  digest: ContentBlobDigestSchema
})
const UnknownPersistedWorkspaceId = WorkspaceId.make("00000000-0000-7000-8000-000000000000")

const makeDiffContentCacheRepository = Effect.gen(function*() {
  const database = yield* Database
  const sql = database.sql

  const get = Effect.fn("DiffContentCacheRepository.get")(function*(key: DiffContentCacheKey) {
    const rows = yield* sql<SqlRow>`SELECT content_digest AS digest
      FROM diff_content_cache_entries
      WHERE workspace_id = ${key.workspaceId}
        AND plugin_connection_id = ${key.pluginConnectionId}
        AND vendor_immutable_id = ${key.vendorImmutableId}
        AND source_revision = ${key.revision}
        AND file_anchor = ${key.anchor}
        AND file_status = ${key.status}
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

  const requestCleanup = Effect.fn("DiffContentCacheRepository.requestCleanup")(function*(
    workspaceId: WorkspaceId,
    digest: ContentBlobDigest
  ) {
    const requestedAt = Schema.encodeSync(UtcTimestamp)(yield* DateTime.now)
    yield* sql`INSERT INTO diff_content_cache_cleanup (
        workspace_id, content_digest, requested_at
      )
      SELECT blobs.workspace_id, blobs.digest, ${requestedAt}
      FROM content_blobs AS blobs
      WHERE blobs.workspace_id = ${workspaceId}
        AND blobs.digest = ${digest}
        AND blobs.storage_class = 'reproducible-cache'
      ON CONFLICT (workspace_id, content_digest) DO NOTHING`.pipe(
      mapPersistenceOperation("diff-content-cache.request-cleanup")
    )
  })

  return {
    cancelCleanup: Effect.fn("DiffContentCacheRepository.cancelCleanup")(function*(
      workspaceId: WorkspaceId,
      digest: ContentBlobDigest
    ) {
      yield* sql`DELETE FROM diff_content_cache_cleanup
        WHERE workspace_id = ${workspaceId}
          AND content_digest = ${digest}`.pipe(
        mapPersistenceOperation("diff-content-cache.cancel-cleanup")
      )
    }),
    completeCleanup: Effect.fn("DiffContentCacheRepository.completeCleanup")(function*(
      workspaceId: WorkspaceId,
      digest: ContentBlobDigest
    ) {
      yield* sql`DELETE FROM content_blobs
        WHERE workspace_id = ${workspaceId}
          AND digest = ${digest}
          AND storage_class = 'reproducible-cache'
          AND EXISTS (
            SELECT 1
            FROM diff_content_cache_cleanup
            WHERE workspace_id = ${workspaceId}
              AND content_digest = ${digest}
          )
          AND NOT EXISTS (
            SELECT 1
            FROM diff_content_cache_entries
            WHERE workspace_id = ${workspaceId}
              AND content_digest = ${digest}
        )`.pipe(mapPersistenceOperation("diff-content-cache.complete-cleanup"))
    }),
    deferCleanup: Effect.fn("DiffContentCacheRepository.deferCleanup")(function*(
      workspaceId: WorkspaceId,
      digest: ContentBlobDigest
    ) {
      const requestedAt = Schema.encodeSync(UtcTimestamp)(yield* DateTime.now)
      yield* sql`UPDATE diff_content_cache_cleanup
        SET requested_at = ${requestedAt},
            attempt_count = attempt_count + 1
        WHERE workspace_id = ${workspaceId}
          AND content_digest = ${digest}`.pipe(
        mapPersistenceOperation("diff-content-cache.defer-cleanup")
      )
    }),
    get,
    isReferenced: Effect.fn("DiffContentCacheRepository.isReferenced")(function*(
      workspaceId: WorkspaceId,
      digest: ContentBlobDigest
    ) {
      const rows = yield* sql`SELECT 1
        FROM diff_content_cache_entries
        WHERE workspace_id = ${workspaceId}
          AND content_digest = ${digest}
        LIMIT 1`.pipe(mapPersistenceOperation("diff-content-cache.is-referenced"))
      return rows.length > 0
    }),
    pendingCleanup: Effect.fn("DiffContentCacheRepository.pendingCleanup")(function*(
      maximumCandidates: number = MaximumDiffContentCacheCleanupBatch
    ) {
      const rows = yield* sql<SqlRow>`SELECT
          workspace_id AS workspaceId,
          content_digest AS digest
        FROM diff_content_cache_cleanup
        ORDER BY attempt_count, requested_at, workspace_id, content_digest
        LIMIT ${maximumCandidates}`.pipe(
        mapPersistenceOperation("diff-content-cache.pending-cleanup")
      )
      const decoded = Schema.decodeUnknownResult(Schema.Array(CleanupCandidateRow))(rows)
      if (Result.isSuccess(decoded)) return decoded.success
      return yield* new PersistedRecordError({
        workspaceId: UnknownPersistedWorkspaceId,
        recordKind: "diff-content-cache-cleanup",
        recordKey: "pending",
        diagnosticCode: "diff-content-cache-cleanup-schema-invalid"
      })
    }),
    put: Effect.fn("DiffContentCacheRepository.put")(function*(
      key: DiffContentCacheKey,
      digest: ContentBlobDigest,
      maximumEntries: number = MaximumDiffContentCacheEntriesPerWorkspace
    ) {
      const cachedAt = yield* DateTime.now
      const encodedCachedAt = Schema.encodeSync(UtcTimestamp)(cachedAt)
      return yield* database.transaction(
        Effect.gen(function*() {
          yield* sql`INSERT INTO diff_content_cache_cleanup (
              workspace_id, content_digest, requested_at
            )
            SELECT entries.workspace_id, entries.content_digest, ${encodedCachedAt}
            FROM diff_content_cache_entries AS entries
            JOIN content_blobs AS blobs
              ON blobs.workspace_id = entries.workspace_id
              AND blobs.digest = entries.content_digest
            WHERE entries.workspace_id = ${key.workspaceId}
              AND entries.plugin_connection_id = ${key.pluginConnectionId}
              AND entries.vendor_immutable_id = ${key.vendorImmutableId}
              AND entries.source_revision = ${key.revision}
              AND entries.file_anchor = ${key.anchor}
              AND entries.file_status = ${key.status}
              AND entries.side = ${key.side}
              AND entries.content_digest <> ${digest}
              AND blobs.storage_class = 'reproducible-cache'
            ON CONFLICT (workspace_id, content_digest) DO NOTHING`

          yield* sql`INSERT INTO diff_content_cache_entries (
              workspace_id, plugin_connection_id, vendor_immutable_id, source_revision,
              file_anchor, file_status, side, content_digest, cached_at
            ) VALUES (
              ${key.workspaceId}, ${key.pluginConnectionId}, ${key.vendorImmutableId}, ${key.revision},
              ${key.anchor}, ${key.status}, ${key.side}, ${digest}, ${encodedCachedAt}
            )
            ON CONFLICT (
              workspace_id, plugin_connection_id, vendor_immutable_id, source_revision,
              file_anchor, file_status, side
            ) DO UPDATE SET
              content_digest = excluded.content_digest,
              cached_at = excluded.cached_at`

          yield* sql`INSERT INTO diff_content_cache_cleanup (
              workspace_id, content_digest, requested_at
            )
            SELECT DISTINCT entries.workspace_id, entries.content_digest, ${encodedCachedAt}
            FROM diff_content_cache_entries AS entries
            JOIN content_blobs AS blobs
              ON blobs.workspace_id = entries.workspace_id
              AND blobs.digest = entries.content_digest
            WHERE entries.workspace_id = ${key.workspaceId}
              AND entries.rowid IN (
                SELECT rowid
                FROM diff_content_cache_entries
                WHERE workspace_id = ${key.workspaceId}
                ORDER BY cached_at DESC, rowid DESC
                LIMIT -1 OFFSET ${maximumEntries}
              )
              AND blobs.storage_class = 'reproducible-cache'
            ON CONFLICT (workspace_id, content_digest) DO NOTHING`

          yield* sql`DELETE FROM diff_content_cache_entries
            WHERE workspace_id = ${key.workspaceId}
              AND rowid IN (
                SELECT rowid
                FROM diff_content_cache_entries
                WHERE workspace_id = ${key.workspaceId}
                ORDER BY cached_at DESC, rowid DESC
                LIMIT -1 OFFSET ${maximumEntries}
              )`
        })
      ).pipe(mapPersistenceOperation("diff-content-cache.put"))
    }),
    requestCleanup
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
