import { Effect } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"

/** Add durable, revisioned plugin configuration whose secret values remain opaque references. */
export const migration0005PluginConfiguration = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient

  yield* sql`CREATE TABLE plugin_configurations (
    workspace_id TEXT NOT NULL,
    plugin_connection_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(revision >= 1),
    configuration_json TEXT NOT NULL CHECK(length(configuration_json) BETWEEN 2 AND 65536),
    configuration_digest TEXT NOT NULL CHECK(
      length(configuration_digest) = 64 AND configuration_digest NOT GLOB '*[^0-9a-f]*'
    ),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (workspace_id, plugin_connection_id),
    FOREIGN KEY (workspace_id, plugin_connection_id)
      REFERENCES plugin_connections(workspace_id, plugin_connection_id),
    CHECK(created_at <= updated_at)
  )`

  yield* sql`CREATE INDEX plugin_configuration_updated_idx
    ON plugin_configurations(workspace_id, updated_at DESC, plugin_connection_id)`

  yield* sql`CREATE TABLE plugin_secret_bindings (
    secret_ref TEXT PRIMARY KEY CHECK(
      length(secret_ref) = 71 AND substr(secret_ref, 1, 7) = 'secret_' AND
      substr(secret_ref, 8) NOT GLOB '*[^0-9a-f]*'
    ),
    workspace_id TEXT NOT NULL,
    plugin_connection_id TEXT NOT NULL,
    field_key TEXT NOT NULL CHECK(length(field_key) BETWEEN 1 AND 100),
    FOREIGN KEY (workspace_id, plugin_connection_id)
      REFERENCES plugin_connections(workspace_id, plugin_connection_id)
  )`

  yield* sql`CREATE INDEX plugin_secret_binding_scope_idx
    ON plugin_secret_bindings(workspace_id, plugin_connection_id, field_key)`
})
