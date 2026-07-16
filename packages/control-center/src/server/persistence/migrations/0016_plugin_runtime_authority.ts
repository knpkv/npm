import { Effect } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"

const currentSourcePredicate = (authority: "NEW" | "authority") => `
  EXISTS (
    SELECT 1
    FROM plugin_connections connection
    JOIN plugin_runtime_state runtime
      ON runtime.workspace_id = connection.workspace_id
      AND runtime.plugin_connection_id = connection.plugin_connection_id
      AND runtime.provider_id = connection.provider_id
    WHERE connection.workspace_id = ${authority}.workspace_id
      AND connection.plugin_connection_id = ${authority}.plugin_connection_id
      AND connection.provider_id = ${authority}.provider_id
      AND connection.is_enabled = 1
      AND connection.revision = ${authority}.connection_revision
      AND connection.updated_at <= ${authority}.activated_at
      AND runtime.descriptor_generation = ${authority}.descriptor_generation
      AND runtime.descriptor_digest = ${authority}.descriptor_digest
      AND runtime.accepted_at <= ${authority}.activated_at
      AND (
        (
          ${authority}.configuration_revision IS NULL
          AND ${authority}.configuration_digest IS NULL
          AND NOT EXISTS (
            SELECT 1
            FROM plugin_configurations configuration
            WHERE configuration.workspace_id = ${authority}.workspace_id
              AND configuration.plugin_connection_id = ${authority}.plugin_connection_id
          )
        ) OR (
          ${authority}.configuration_revision IS NOT NULL
          AND ${authority}.configuration_digest IS NOT NULL
          AND EXISTS (
            SELECT 1
            FROM plugin_configurations configuration
            WHERE configuration.workspace_id = ${authority}.workspace_id
              AND configuration.plugin_connection_id = ${authority}.plugin_connection_id
              AND configuration.revision = ${authority}.configuration_revision
              AND configuration.configuration_digest = ${authority}.configuration_digest
              AND configuration.updated_at <= ${authority}.activated_at
          )
        )
      )
  )`

/** Persist the exact current runtime generation trusted for governed provider actions. */
export const migration0016PluginRuntimeAuthority = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient

  yield* sql`ALTER TABLE plugin_runtime_state ADD COLUMN descriptor_generation
    INTEGER NOT NULL DEFAULT 1 CHECK(descriptor_generation >= 1)`

  yield* sql`CREATE TRIGGER plugin_runtime_descriptor_generation_exact_update
    BEFORE UPDATE ON plugin_runtime_state
    WHEN NEW.descriptor_generation < OLD.descriptor_generation
      OR NEW.descriptor_generation > OLD.descriptor_generation + 1
      OR (
        (
          NEW.provider_id <> OLD.provider_id
          OR NEW.descriptor_schema_version <> OLD.descriptor_schema_version
          OR NEW.descriptor_json <> OLD.descriptor_json
          OR NEW.descriptor_digest <> OLD.descriptor_digest
          OR NEW.accepted_at <> OLD.accepted_at
        )
        AND NEW.descriptor_generation <> OLD.descriptor_generation + 1
      )
    BEGIN
      SELECT RAISE(ABORT, 'plugin runtime descriptor generation must advance exactly');
    END`

  yield* sql`CREATE TABLE plugin_runtime_authority_heads (
    workspace_id TEXT NOT NULL,
    plugin_connection_id TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    authority_schema_version INTEGER NOT NULL CHECK(authority_schema_version = 1),
    generation INTEGER NOT NULL CHECK(generation >= 1),
    connection_revision INTEGER NOT NULL CHECK(connection_revision >= 1),
    descriptor_generation INTEGER NOT NULL CHECK(descriptor_generation >= 1),
    configuration_revision INTEGER,
    configuration_digest TEXT,
    descriptor_digest TEXT NOT NULL CHECK(
      length(descriptor_digest) = 64 AND descriptor_digest NOT GLOB '*[^0-9a-f]*'
    ),
    account_digest TEXT NOT NULL CHECK(
      length(account_digest) = 71 AND substr(account_digest, 1, 7) = 'sha256:' AND
      substr(account_digest, 8) NOT GLOB '*[^0-9a-f]*'
    ),
    authority_digest TEXT NOT NULL CHECK(
      length(authority_digest) = 71 AND substr(authority_digest, 1, 7) = 'sha256:' AND
      substr(authority_digest, 8) NOT GLOB '*[^0-9a-f]*'
    ),
    activated_at TEXT NOT NULL CHECK(
      length(activated_at) = 24 AND
      activated_at GLOB
        '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
    ),
    PRIMARY KEY (workspace_id, plugin_connection_id),
    FOREIGN KEY (workspace_id, plugin_connection_id, provider_id)
      REFERENCES plugin_connections(workspace_id, plugin_connection_id, provider_id),
    CHECK(
      (configuration_revision IS NULL AND configuration_digest IS NULL) OR
      (
        configuration_revision IS NOT NULL AND configuration_revision >= 1 AND
        configuration_digest IS NOT NULL AND length(configuration_digest) = 64 AND
        configuration_digest NOT GLOB '*[^0-9a-f]*'
      )
    )
  )`

  yield* sql`CREATE TABLE plugin_runtime_authority_generations (
    workspace_id TEXT NOT NULL,
    plugin_connection_id TEXT NOT NULL,
    generation INTEGER NOT NULL CHECK(generation >= 1),
    authority_digest TEXT NOT NULL CHECK(
      length(authority_digest) = 71 AND substr(authority_digest, 1, 7) = 'sha256:' AND
      substr(authority_digest, 8) NOT GLOB '*[^0-9a-f]*'
    ),
    activated_at TEXT NOT NULL,
    PRIMARY KEY (workspace_id, plugin_connection_id, generation),
    UNIQUE (workspace_id, plugin_connection_id, authority_digest),
    FOREIGN KEY (workspace_id, plugin_connection_id)
      REFERENCES plugin_connections(workspace_id, plugin_connection_id)
  )`

  yield* sql.unsafe(`CREATE VIEW current_plugin_runtime_authority_heads AS
    SELECT authority.*
    FROM plugin_runtime_authority_heads authority
    WHERE ${currentSourcePredicate("authority")}`)

  yield* sql.unsafe(`CREATE TRIGGER plugin_runtime_authority_head_current_insert
    BEFORE INSERT ON plugin_runtime_authority_heads
    WHEN NEW.generation <> 1 OR NOT (${currentSourcePredicate("NEW")})
    BEGIN
      SELECT RAISE(ABORT, 'plugin runtime authority must match the current enabled source');
    END`)

  yield* sql.unsafe(`CREATE TRIGGER plugin_runtime_authority_head_current_update
    BEFORE UPDATE ON plugin_runtime_authority_heads
    WHEN NOT (${currentSourcePredicate("NEW")})
    BEGIN
      SELECT RAISE(ABORT, 'plugin runtime authority must match the current enabled source');
    END`)

  yield* sql`CREATE TRIGGER plugin_runtime_authority_head_exact_update
    BEFORE UPDATE ON plugin_runtime_authority_heads
    WHEN NEW.workspace_id <> OLD.workspace_id
      OR NEW.plugin_connection_id <> OLD.plugin_connection_id
      OR NEW.provider_id <> OLD.provider_id
      OR NEW.generation <> OLD.generation + 1
      OR NEW.activated_at < OLD.activated_at
    BEGIN
      SELECT RAISE(ABORT, 'plugin runtime authority generation must advance exactly');
    END`

  yield* sql`CREATE TRIGGER plugin_runtime_authority_head_no_delete
    BEFORE DELETE ON plugin_runtime_authority_heads
    BEGIN
      SELECT RAISE(ABORT, 'plugin runtime authority generation cannot be deleted');
    END`

  yield* sql`CREATE TRIGGER plugin_runtime_authority_head_record_initial_generation
    AFTER INSERT ON plugin_runtime_authority_heads
    BEGIN
      INSERT INTO plugin_runtime_authority_generations (
        workspace_id, plugin_connection_id, generation, authority_digest, activated_at
      ) VALUES (
        NEW.workspace_id, NEW.plugin_connection_id, NEW.generation,
        NEW.authority_digest, NEW.activated_at
      );
    END`

  yield* sql`CREATE TRIGGER plugin_runtime_authority_head_record_next_generation
    AFTER UPDATE ON plugin_runtime_authority_heads
    BEGIN
      INSERT INTO plugin_runtime_authority_generations (
        workspace_id, plugin_connection_id, generation, authority_digest, activated_at
      ) VALUES (
        NEW.workspace_id, NEW.plugin_connection_id, NEW.generation,
        NEW.authority_digest, NEW.activated_at
      );
    END`

  yield* sql`CREATE TRIGGER plugin_runtime_authority_generation_immutable_update
    BEFORE UPDATE ON plugin_runtime_authority_generations
    BEGIN
      SELECT RAISE(ABORT, 'plugin runtime authority generation is immutable');
    END`

  yield* sql`CREATE TRIGGER plugin_runtime_authority_generation_no_delete
    BEFORE DELETE ON plugin_runtime_authority_generations
    BEGIN
      SELECT RAISE(ABORT, 'plugin runtime authority generation cannot be deleted');
    END`

  yield* sql`CREATE TRIGGER plugin_runtime_state_no_delete_after_authority
    BEFORE DELETE ON plugin_runtime_state
    WHEN EXISTS (
      SELECT 1
      FROM plugin_runtime_authority_generations authority
      WHERE authority.workspace_id = OLD.workspace_id
        AND authority.plugin_connection_id = OLD.plugin_connection_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'authorized plugin runtime state cannot be recreated');
    END`
})
