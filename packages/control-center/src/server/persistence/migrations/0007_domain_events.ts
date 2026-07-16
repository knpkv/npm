import { Effect } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"

/** Add workspace-local durable event streams and their replay outbox. */
export const migration0007DomainEvents = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient

  yield* sql`CREATE TABLE domain_event_streams (
    workspace_id TEXT NOT NULL,
    next_cursor INTEGER NOT NULL DEFAULT 1 CHECK(
      next_cursor BETWEEN 1 AND 9007199254740991
    ),
    pruned_through_cursor INTEGER NOT NULL DEFAULT 0 CHECK(
      pruned_through_cursor >= 0 AND pruned_through_cursor < next_cursor
    ),
    updated_at TEXT NOT NULL,
    PRIMARY KEY (workspace_id),
    FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id)
  )`

  yield* sql`CREATE TABLE domain_events (
    workspace_id TEXT NOT NULL,
    event_cursor INTEGER NOT NULL CHECK(
      event_cursor BETWEEN 1 AND 9007199254740990
    ),
    event_id TEXT NOT NULL,
    schema_version INTEGER NOT NULL CHECK(schema_version >= 1),
    event_type TEXT NOT NULL CHECK(length(event_type) BETWEEN 1 AND 100),
    dedupe_key TEXT NOT NULL CHECK(length(dedupe_key) BETWEEN 1 AND 512),
    release_id TEXT,
    plugin_connection_id TEXT,
    entity_id TEXT,
    job_id TEXT,
    occurred_at TEXT NOT NULL,
    ingested_at TEXT NOT NULL,
    causation_id TEXT,
    correlation_id TEXT CHECK(
      correlation_id IS NULL OR length(correlation_id) BETWEEN 1 AND 128
    ),
    payload_json TEXT NOT NULL CHECK(length(payload_json) BETWEEN 1 AND 65536),
    payload_digest TEXT NOT NULL CHECK(
      length(payload_digest) = 64 AND
      payload_digest NOT GLOB '*[^0-9a-f]*'
    ),
    PRIMARY KEY (workspace_id, event_cursor),
    UNIQUE (workspace_id, event_id),
    UNIQUE (workspace_id, event_type, dedupe_key),
    FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id),
    FOREIGN KEY (workspace_id, release_id)
      REFERENCES releases(workspace_id, release_id),
    FOREIGN KEY (workspace_id, plugin_connection_id)
      REFERENCES plugin_connections(workspace_id, plugin_connection_id),
    FOREIGN KEY (workspace_id, entity_id)
      REFERENCES entities(workspace_id, entity_id)
  )`

  yield* sql`CREATE INDEX domain_events_retention_idx
    ON domain_events(workspace_id, ingested_at, event_cursor)`
})
