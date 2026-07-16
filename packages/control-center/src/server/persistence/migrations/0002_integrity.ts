import { Effect } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"

/** Add content metadata, bounded quarantine diagnostics, and query indexes. */
export const migration0002Integrity = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient

  yield* sql`CREATE TABLE content_blobs (
    workspace_id TEXT NOT NULL,
    digest TEXT NOT NULL CHECK(
      length(digest) = 64 AND
      digest NOT GLOB '*[^0-9a-f]*'
    ),
    storage_class TEXT NOT NULL CHECK(storage_class IN ('durable', 'reproducible-cache')),
    byte_length INTEGER NOT NULL CHECK(byte_length >= 0),
    mime_type TEXT CHECK(mime_type IS NULL OR length(mime_type) BETWEEN 1 AND 255),
    created_at TEXT NOT NULL,
    last_verified_at TEXT,
    PRIMARY KEY (workspace_id, digest),
    FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id),
    CHECK(last_verified_at IS NULL OR created_at <= last_verified_at)
  )`

  yield* sql`CREATE TABLE quarantined_records (
    workspace_id TEXT NOT NULL,
    record_kind TEXT NOT NULL CHECK(length(record_kind) BETWEEN 1 AND 100),
    record_key TEXT NOT NULL CHECK(length(record_key) BETWEEN 1 AND 500),
    schema_version INTEGER NOT NULL CHECK(schema_version >= 1),
    payload_digest TEXT NOT NULL CHECK(
      length(payload_digest) = 64 AND
      payload_digest NOT GLOB '*[^0-9a-f]*'
    ),
    diagnostic_code TEXT NOT NULL CHECK(length(diagnostic_code) BETWEEN 1 AND 100),
    diagnostic_summary TEXT NOT NULL CHECK(length(diagnostic_summary) BETWEEN 1 AND 1000),
    first_observed_at TEXT NOT NULL,
    last_observed_at TEXT NOT NULL,
    occurrence_count INTEGER NOT NULL DEFAULT 1 CHECK(occurrence_count >= 1),
    PRIMARY KEY (
      workspace_id,
      record_kind,
      record_key,
      schema_version,
      payload_digest,
      diagnostic_code
    ),
    FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id),
    CHECK(first_observed_at <= last_observed_at)
  )`

  yield* sql`CREATE INDEX releases_updated_at_idx
    ON releases(workspace_id, updated_at DESC)`
  yield* sql`CREATE INDEX release_revisions_created_at_idx
    ON release_revisions(workspace_id, release_id, created_at DESC)`
  yield* sql`CREATE INDEX release_targets_environment_idx
    ON release_targets(workspace_id, environment_id, release_id)`
  yield* sql`CREATE INDEX entities_type_updated_at_idx
    ON entities(workspace_id, entity_type, updated_at DESC)`
  yield* sql`CREATE INDEX entity_revisions_synchronized_at_idx
    ON entity_revisions(workspace_id, synchronized_at DESC)`
  yield* sql`CREATE INDEX persons_display_name_idx
    ON persons(workspace_id, display_name)`
  yield* sql`CREATE INDEX role_assignments_release_idx
    ON role_assignments(workspace_id, release_id, role)`
  yield* sql`CREATE INDEX role_assignments_entity_idx
    ON role_assignments(workspace_id, entity_id, role)`
  yield* sql`CREATE INDEX content_blobs_storage_created_idx
    ON content_blobs(workspace_id, storage_class, created_at)`
  yield* sql`CREATE INDEX quarantined_records_last_observed_idx
    ON quarantined_records(workspace_id, last_observed_at DESC)`
})
