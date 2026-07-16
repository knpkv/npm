import { Effect } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"

/** Create the workspace-scoped release, entity, plugin, and people foundation. */
export const migration0001Core = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient

  yield* sql`CREATE TABLE workspaces (
    workspace_id TEXT NOT NULL,
    display_name TEXT NOT NULL CHECK(length(display_name) BETWEEN 1 AND 200),
    revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (workspace_id),
    CHECK(created_at <= updated_at)
  )`

  yield* sql`CREATE TABLE plugin_connections (
    workspace_id TEXT NOT NULL,
    plugin_connection_id TEXT NOT NULL,
    provider_id TEXT NOT NULL CHECK(provider_id IN (
      'codecommit', 'codepipeline', 'jira', 'confluence', 'clockify'
    )),
    display_name TEXT NOT NULL CHECK(length(display_name) BETWEEN 1 AND 200),
    revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
    is_enabled INTEGER NOT NULL DEFAULT 1 CHECK(is_enabled IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (workspace_id, plugin_connection_id),
    UNIQUE (workspace_id, plugin_connection_id, provider_id),
    FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id),
    CHECK(created_at <= updated_at)
  )`

  yield* sql`CREATE TABLE releases (
    workspace_id TEXT NOT NULL,
    release_id TEXT NOT NULL,
    current_revision INTEGER NOT NULL CHECK(current_revision >= 1),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (workspace_id, release_id),
    FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id),
    CHECK(created_at <= updated_at)
  )`

  yield* sql`CREATE TABLE release_revisions (
    workspace_id TEXT NOT NULL,
    release_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(revision >= 1),
    snapshot_json TEXT NOT NULL CHECK(length(snapshot_json) > 0),
    snapshot_digest TEXT NOT NULL CHECK(
      length(snapshot_digest) = 64 AND
      snapshot_digest NOT GLOB '*[^0-9a-f]*'
    ),
    created_at TEXT NOT NULL,
    PRIMARY KEY (workspace_id, release_id, revision),
    FOREIGN KEY (workspace_id, release_id)
      REFERENCES releases(workspace_id, release_id)
  )`

  yield* sql`CREATE TABLE release_targets (
    workspace_id TEXT NOT NULL,
    release_id TEXT NOT NULL,
    environment_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (workspace_id, release_id, environment_id),
    FOREIGN KEY (workspace_id, release_id)
      REFERENCES releases(workspace_id, release_id)
  )`

  yield* sql`CREATE TABLE entities (
    workspace_id TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    plugin_connection_id TEXT NOT NULL,
    provider_id TEXT NOT NULL CHECK(provider_id IN (
      'codecommit', 'codepipeline', 'jira', 'confluence', 'clockify'
    )),
    vendor_immutable_id TEXT NOT NULL CHECK(length(vendor_immutable_id) BETWEEN 1 AND 512),
    entity_type TEXT NOT NULL CHECK(length(entity_type) BETWEEN 1 AND 100),
    current_revision INTEGER NOT NULL CHECK(current_revision >= 1),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (workspace_id, entity_id),
    UNIQUE (
      workspace_id,
      plugin_connection_id,
      provider_id,
      vendor_immutable_id
    ),
    FOREIGN KEY (workspace_id, plugin_connection_id, provider_id)
      REFERENCES plugin_connections(workspace_id, plugin_connection_id, provider_id),
    CHECK(created_at <= updated_at)
  )`

  yield* sql`CREATE TABLE entity_revisions (
    workspace_id TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(revision >= 1),
    source_revision TEXT NOT NULL CHECK(length(source_revision) BETWEEN 1 AND 512),
    normalization_schema_version INTEGER NOT NULL CHECK(normalization_schema_version >= 1),
    source_url TEXT,
    first_observed_at TEXT NOT NULL,
    last_observed_at TEXT NOT NULL,
    synchronized_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (workspace_id, entity_id, revision),
    FOREIGN KEY (workspace_id, entity_id)
      REFERENCES entities(workspace_id, entity_id),
    CHECK(first_observed_at <= last_observed_at),
    CHECK(last_observed_at <= synchronized_at)
  )`

  yield* sql`CREATE TABLE persons (
    workspace_id TEXT NOT NULL,
    person_id TEXT NOT NULL,
    display_name TEXT NOT NULL CHECK(length(display_name) BETWEEN 1 AND 200),
    avatar_json TEXT NOT NULL CHECK(length(avatar_json) > 0),
    is_active INTEGER NOT NULL CHECK(is_active IN (0, 1)),
    revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (workspace_id, person_id),
    FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id),
    CHECK(created_at <= updated_at)
  )`

  yield* sql`CREATE TABLE person_identities (
    workspace_id TEXT NOT NULL,
    person_id TEXT NOT NULL,
    plugin_connection_id TEXT NOT NULL,
    provider_id TEXT NOT NULL CHECK(provider_id IN (
      'codecommit', 'codepipeline', 'jira', 'confluence', 'clockify'
    )),
    vendor_person_id TEXT NOT NULL CHECK(length(vendor_person_id) BETWEEN 1 AND 512),
    created_at TEXT NOT NULL,
    PRIMARY KEY (
      workspace_id,
      person_id,
      plugin_connection_id,
      provider_id,
      vendor_person_id
    ),
    UNIQUE (workspace_id, plugin_connection_id, provider_id, vendor_person_id),
    FOREIGN KEY (workspace_id, person_id)
      REFERENCES persons(workspace_id, person_id),
    FOREIGN KEY (workspace_id, plugin_connection_id, provider_id)
      REFERENCES plugin_connections(workspace_id, plugin_connection_id, provider_id)
  )`

  yield* sql`CREATE TABLE role_assignments (
    workspace_id TEXT NOT NULL,
    assignment_id TEXT NOT NULL,
    actor_kind TEXT NOT NULL CHECK(actor_kind IN ('human', 'agent')),
    person_id TEXT,
    agent_id TEXT,
    role TEXT NOT NULL CHECK(role IN (
      'workspace-owner', 'workspace-approver', 'release-owner',
      'release-approver', 'change-owner', 'issue-owner', 'issue-assignee',
      'page-owner', 'author', 'contributor', 'reviewer', 'operator',
      'deployment-approver', 'merge-approver', 'watcher'
    )),
    scope_kind TEXT NOT NULL CHECK(scope_kind IN (
      'workspace', 'release', 'environment', 'entity'
    )),
    release_id TEXT,
    environment_id TEXT,
    entity_id TEXT,
    lifecycle_kind TEXT NOT NULL CHECK(lifecycle_kind IN ('active', 'ended', 'revoked')),
    assigned_at TEXT NOT NULL,
    ended_at TEXT,
    revoked_at TEXT,
    revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (workspace_id, assignment_id),
    FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id),
    FOREIGN KEY (workspace_id, person_id)
      REFERENCES persons(workspace_id, person_id),
    FOREIGN KEY (workspace_id, release_id)
      REFERENCES releases(workspace_id, release_id),
    FOREIGN KEY (workspace_id, release_id, environment_id)
      REFERENCES release_targets(workspace_id, release_id, environment_id),
    FOREIGN KEY (workspace_id, entity_id)
      REFERENCES entities(workspace_id, entity_id),
    CHECK(
      (actor_kind = 'human' AND person_id IS NOT NULL AND agent_id IS NULL) OR
      (actor_kind = 'agent' AND agent_id IS NOT NULL AND person_id IS NULL)
    ),
    CHECK(
      (scope_kind = 'workspace' AND release_id IS NULL AND environment_id IS NULL AND entity_id IS NULL) OR
      (scope_kind = 'release' AND release_id IS NOT NULL AND environment_id IS NULL AND entity_id IS NULL) OR
      (scope_kind = 'environment' AND release_id IS NOT NULL AND environment_id IS NOT NULL AND entity_id IS NULL) OR
      (scope_kind = 'entity' AND release_id IS NULL AND environment_id IS NULL AND entity_id IS NOT NULL)
    ),
    CHECK(
      (lifecycle_kind = 'active' AND ended_at IS NULL AND revoked_at IS NULL) OR
      (lifecycle_kind = 'ended' AND ended_at IS NOT NULL AND revoked_at IS NULL AND assigned_at <= ended_at) OR
      (lifecycle_kind = 'revoked' AND ended_at IS NULL AND revoked_at IS NOT NULL AND assigned_at <= revoked_at)
    ),
    CHECK(created_at <= updated_at)
  )`
})
