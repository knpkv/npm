import { Effect } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"

/** Add durable plugin descriptors, health, sync checkpoints, cache heads, and evidence. */
export const migration0004PluginRuntime = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient

  yield* sql`CREATE TABLE plugin_runtime_state (
    workspace_id TEXT NOT NULL,
    plugin_connection_id TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
    descriptor_schema_version INTEGER NOT NULL CHECK(descriptor_schema_version >= 1),
    descriptor_json TEXT NOT NULL CHECK(length(descriptor_json) BETWEEN 2 AND 65536),
    descriptor_digest TEXT NOT NULL CHECK(length(descriptor_digest) = 64 AND descriptor_digest NOT GLOB '*[^0-9a-f]*'),
    accepted_at TEXT NOT NULL,
    health_state TEXT NOT NULL CHECK(health_state IN ('healthy', 'degraded', 'unavailable', 'disabled')),
    failure_class TEXT CHECK(failure_class IS NULL OR failure_class IN (
      'authentication', 'authorization', 'rate-limit', 'timeout', 'malformed-response', 'outage', 'unknown'
    )),
    safe_message TEXT CHECK(safe_message IS NULL OR length(safe_message) BETWEEN 1 AND 500),
    checked_at TEXT NOT NULL,
    retry_at TEXT,
    consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK(consecutive_failures >= 0),
    PRIMARY KEY (workspace_id, plugin_connection_id),
    FOREIGN KEY (workspace_id, plugin_connection_id, provider_id)
      REFERENCES plugin_connections(workspace_id, plugin_connection_id, provider_id),
    CHECK(retry_at IS NULL OR checked_at <= retry_at),
    CHECK(
      (health_state IN ('healthy', 'disabled') AND failure_class IS NULL AND safe_message IS NULL AND retry_at IS NULL) OR
      (health_state IN ('degraded', 'unavailable') AND failure_class IS NOT NULL AND safe_message IS NOT NULL)
    )
  )`

  yield* sql`CREATE TABLE plugin_sync_streams (
    workspace_id TEXT NOT NULL,
    plugin_connection_id TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    stream_key TEXT NOT NULL CHECK(length(stream_key) BETWEEN 1 AND 100),
    revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
    checkpoint_json TEXT CHECK(checkpoint_json IS NULL OR length(checkpoint_json) BETWEEN 2 AND 65536),
    checkpoint_digest TEXT CHECK(checkpoint_digest IS NULL OR (length(checkpoint_digest) = 64 AND checkpoint_digest NOT GLOB '*[^0-9a-f]*')),
    last_page_id TEXT,
    synchronized_at TEXT,
    PRIMARY KEY (workspace_id, plugin_connection_id, stream_key),
    FOREIGN KEY (workspace_id, plugin_connection_id, provider_id)
      REFERENCES plugin_connections(workspace_id, plugin_connection_id, provider_id),
    CHECK((checkpoint_json IS NULL) = (checkpoint_digest IS NULL))
  )`

  yield* sql`CREATE TABLE plugin_sync_pages (
    workspace_id TEXT NOT NULL,
    plugin_connection_id TEXT NOT NULL,
    stream_key TEXT NOT NULL,
    page_id TEXT NOT NULL CHECK(length(page_id) BETWEEN 1 AND 200),
    expected_revision INTEGER NOT NULL CHECK(expected_revision >= 0),
    page_digest TEXT NOT NULL CHECK(length(page_digest) = 64 AND page_digest NOT GLOB '*[^0-9a-f]*'),
    checkpoint_digest TEXT NOT NULL CHECK(length(checkpoint_digest) = 64 AND checkpoint_digest NOT GLOB '*[^0-9a-f]*'),
    event_count INTEGER NOT NULL CHECK(event_count >= 0),
    committed_at TEXT NOT NULL,
    PRIMARY KEY (workspace_id, plugin_connection_id, stream_key, page_id),
    UNIQUE (workspace_id, plugin_connection_id, stream_key, expected_revision),
    FOREIGN KEY (workspace_id, plugin_connection_id, stream_key)
      REFERENCES plugin_sync_streams(workspace_id, plugin_connection_id, stream_key)
  )`

  yield* sql`CREATE TABLE plugin_cache_entries (
    workspace_id TEXT NOT NULL,
    plugin_connection_id TEXT NOT NULL,
    stream_key TEXT NOT NULL,
    record_key TEXT NOT NULL CHECK(length(record_key) BETWEEN 1 AND 700),
    state TEXT NOT NULL CHECK(state IN ('present', 'tombstoned')),
    payload_json TEXT CHECK(payload_json IS NULL OR length(payload_json) BETWEEN 2 AND 524288),
    payload_digest TEXT CHECK(payload_digest IS NULL OR (length(payload_digest) = 64 AND payload_digest NOT GLOB '*[^0-9a-f]*')),
    source_revision TEXT NOT NULL CHECK(length(source_revision) BETWEEN 1 AND 512),
    last_page_id TEXT NOT NULL,
    cached_at TEXT NOT NULL,
    tombstoned_at TEXT,
    PRIMARY KEY (workspace_id, plugin_connection_id, stream_key, record_key),
    FOREIGN KEY (workspace_id, plugin_connection_id, stream_key)
      REFERENCES plugin_sync_streams(workspace_id, plugin_connection_id, stream_key),
    FOREIGN KEY (workspace_id, plugin_connection_id, stream_key, last_page_id)
      REFERENCES plugin_sync_pages(workspace_id, plugin_connection_id, stream_key, page_id),
    CHECK((payload_json IS NULL) = (payload_digest IS NULL)),
    CHECK(state = 'tombstoned' OR payload_json IS NOT NULL),
    CHECK((state = 'tombstoned') = (tombstoned_at IS NOT NULL))
  )`

  yield* sql`CREATE TABLE plugin_sync_evidence (
    workspace_id TEXT NOT NULL,
    plugin_connection_id TEXT NOT NULL,
    stream_key TEXT NOT NULL,
    page_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
    event_id TEXT NOT NULL CHECK(length(event_id) BETWEEN 1 AND 512),
    event_digest TEXT NOT NULL CHECK(length(event_digest) = 64 AND event_digest NOT GLOB '*[^0-9a-f]*'),
    event_kind TEXT NOT NULL CHECK(event_kind IN ('upsert', 'tombstone')),
    record_key TEXT NOT NULL CHECK(length(record_key) BETWEEN 1 AND 700),
    source_revision TEXT NOT NULL CHECK(length(source_revision) BETWEEN 1 AND 512),
    payload_json TEXT NOT NULL CHECK(length(payload_json) BETWEEN 2 AND 524288),
    observed_at TEXT NOT NULL,
    PRIMARY KEY (workspace_id, plugin_connection_id, stream_key, page_id, ordinal),
    UNIQUE (workspace_id, plugin_connection_id, stream_key, event_id),
    FOREIGN KEY (workspace_id, plugin_connection_id, stream_key, page_id)
      REFERENCES plugin_sync_pages(workspace_id, plugin_connection_id, stream_key, page_id),
    CHECK(length(payload_json) >= 2)
  )`

  yield* sql`CREATE INDEX plugin_runtime_health_retry_idx
    ON plugin_runtime_state(workspace_id, health_state, retry_at)`
  yield* sql`CREATE INDEX plugin_cache_state_idx
    ON plugin_cache_entries(workspace_id, plugin_connection_id, stream_key, state)`
  yield* sql`CREATE INDEX plugin_evidence_record_idx
    ON plugin_sync_evidence(workspace_id, plugin_connection_id, record_key, observed_at DESC)`
})
