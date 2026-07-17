import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Result, Schema } from "effect"

import {
  EntityId,
  PersonId,
  PluginConnectionId,
  SessionId,
  ShareId,
  WorkspaceId
} from "../../src/domain/identifiers.js"
import { UtcTimestamp } from "../../src/domain/utcTimestamp.js"
import { Database, databaseLayer } from "../../src/server/persistence/Database.js"
import {
  PersistenceOperationError,
  RecordAlreadyExistsError,
  RecordNotFoundError
} from "../../src/server/persistence/errors.js"
import { AuthorizedShareRepository } from "../../src/server/persistence/repositories/authorizedShareRepository.js"
import { makePersistenceTestConfig } from "./fixtures.js"

const workspaceId = Schema.decodeSync(WorkspaceId)("01890f6f-6d6a-7cc0-98d2-000000000121")
const otherWorkspaceId = Schema.decodeSync(WorkspaceId)("01890f6f-6d6a-7cc0-98d2-000000000122")
const entityId = Schema.decodeSync(EntityId)("01890f6f-6d6a-7cc0-98d2-000000000123")
const granteePersonId = Schema.decodeSync(PersonId)("01890f6f-6d6a-7cc0-98d2-000000000124")
const creatorPersonId = Schema.decodeSync(PersonId)("01890f6f-6d6a-7cc0-98d2-000000000125")
const sessionId = Schema.decodeSync(SessionId)("01890f6f-6d6a-7cc0-98d2-000000000126")
const shareId = Schema.decodeSync(ShareId)("01890f6f-6d6a-7cc0-98d2-000000000127")
const secondShareId = Schema.decodeSync(ShareId)("01890f6f-6d6a-7cc0-98d2-000000000128")
const pluginConnectionId = Schema.decodeSync(PluginConnectionId)("01890f6f-6d6a-7cc0-98d2-000000000129")
const createdAt = Schema.decodeSync(UtcTimestamp)("2026-07-17T10:00:00.000Z")
const expiresAt = Schema.decodeSync(UtcTimestamp)("2026-07-18T10:00:00.000Z")
const differentExpiresAt = Schema.decodeSync(UtcTimestamp)("2026-07-19T10:00:00.000Z")
const revokedAt = Schema.decodeSync(UtcTimestamp)("2026-07-17T11:00:00.000Z")

const withRepository = <Success, Failure>(
  use: Effect.Effect<Success, Failure, AuthorizedShareRepository | Database>
) =>
  Effect.gen(function*() {
    const config = yield* makePersistenceTestConfig("control-center-authorized-share-repository-")
    const database = databaseLayer(config)
    const repository = AuthorizedShareRepository.layer.pipe(Layer.provideMerge(database))
    return yield* use.pipe(Effect.provide(repository))
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped)

const seedAuthorityAndTarget = Effect.gen(function*() {
  const { sql } = yield* Database
  const created = Schema.encodeSync(UtcTimestamp)(createdAt)
  const expiry = Schema.encodeSync(UtcTimestamp)(expiresAt)
  yield* sql`INSERT INTO workspaces (workspace_id, display_name, revision, created_at, updated_at)
    VALUES (${workspaceId}, 'Payments', 1, ${created}, ${created})`
  yield* sql`INSERT INTO workspaces (workspace_id, display_name, revision, created_at, updated_at)
    VALUES (${otherWorkspaceId}, 'Other', 1, ${created}, ${created})`
  yield* sql`INSERT INTO plugin_connections (
      workspace_id, plugin_connection_id, provider_id, display_name, revision, is_enabled, created_at, updated_at
    ) VALUES (${workspaceId}, ${pluginConnectionId}, 'jira', 'Payments Jira', 1, 1, ${created}, ${created})`
  yield* sql`INSERT INTO persons (
      workspace_id, person_id, display_name, avatar_json, is_active, revision, created_at, updated_at
    ) VALUES
      (${workspaceId}, ${creatorPersonId}, 'Owner', '{"_tag":"initials","text":"OW"}', 1, 1, ${created}, ${created}),
      (${workspaceId}, ${granteePersonId}, 'Grantee', '{"_tag":"initials","text":"GR"}', 1, 1, ${created}, ${created})`
  yield* sql`INSERT INTO sessions (
      workspace_id, session_id, token_hash, csrf_hash, actor_kind, person_id, agent_id,
      permission, created_at, last_seen_at, idle_expires_at, absolute_expires_at, revoked_at
    ) VALUES (
      ${workspaceId}, ${sessionId}, ${"a".repeat(64)}, ${"b".repeat(64)}, 'human',
      ${creatorPersonId}, NULL, 'workspace-owner', ${created}, ${created}, ${expiry}, ${expiry}, NULL
    )`
  yield* sql`INSERT INTO entities (
      workspace_id, entity_id, plugin_connection_id, provider_id, vendor_immutable_id,
      entity_type, current_revision, created_at, updated_at
    ) VALUES (
      ${workspaceId}, ${entityId}, ${pluginConnectionId}, 'jira', 'PAY-42',
      'issue', 1, ${created}, ${created}
    )`
  yield* sql`INSERT INTO entity_revisions (
      workspace_id, entity_id, revision, source_revision, normalization_schema_version,
      source_url, first_observed_at, last_observed_at, synchronized_at, created_at
    ) VALUES (
      ${workspaceId}, ${entityId}, 1, '1001', 1, 'https://jira.example/browse/PAY-42',
      ${created}, ${created}, ${created}, ${created}
    )`
  yield* sql`INSERT INTO entity_projection_revisions (
      workspace_id, entity_id, projection_revision, source_entity_revision,
      supersedes_projection_revision, projection_schema_version, entity_state,
      display_key, title, extension_json, extension_digest, recorded_at
    ) VALUES (
      ${workspaceId}, ${entityId}, 1, 1, NULL, 1, 'present', 'PAY-42',
      'Ship guarded refunds',
      '{"_tag":"issue","key":"PAY-42","status":"Ready","priority":"High","estimatePoints":5}',
      ${"c".repeat(64)}, ${created}
    )`
})

const createInput = (selectedShareId: ShareId) => ({
  workspaceId,
  shareId: selectedShareId,
  entityId,
  granteePersonId,
  createdByPersonId: creatorPersonId,
  createdBySessionId: sessionId,
  createdAt,
  expiresAt
})

describe("authorized share repository", () => {
  it.effect("persists exact grants, isolates workspace lookup, and records immutable revocation", () =>
    withRepository(Effect.gen(function*() {
      yield* seedAuthorityAndTarget
      const repository = yield* AuthorizedShareRepository

      const created = yield* repository.create(createInput(shareId))
      assert.strictEqual(created.target.entityId, entityId)
      assert.strictEqual(created.granteePersonId, granteePersonId)
      assert.isNull(created.revokedAt)

      const retried = yield* repository.create(createInput(shareId))
      assert.deepStrictEqual(retried, created)

      const conflictingRetry = yield* repository.create({
        ...createInput(shareId),
        expiresAt: differentExpiresAt
      }).pipe(Effect.result)
      assert.isTrue(Result.isFailure(conflictingRetry))
      if (Result.isFailure(conflictingRetry)) {
        assert.instanceOf(conflictingRetry.failure, RecordAlreadyExistsError)
      }

      const crossWorkspace = yield* repository.get({ workspaceId: otherWorkspaceId, shareId }).pipe(Effect.result)
      assert.isTrue(Result.isFailure(crossWorkspace))
      if (Result.isFailure(crossWorkspace)) assert.instanceOf(crossWorkspace.failure, RecordNotFoundError)

      const revoked = yield* repository.revoke({
        workspaceId,
        shareId,
        revokedByPersonId: creatorPersonId,
        revokedBySessionId: sessionId,
        revokedAt
      })
      assert.deepStrictEqual(revoked.revokedAt, revokedAt)
      assert.deepStrictEqual(
        (yield* repository.revoke({
          workspaceId,
          shareId,
          revokedByPersonId: creatorPersonId,
          revokedBySessionId: sessionId,
          revokedAt
        })).revokedAt,
        revokedAt
      )
    })))

  it.effect("rejects a grant when the latest projection trails the current entity revision", () =>
    withRepository(Effect.gen(function*() {
      yield* seedAuthorityAndTarget
      const { sql } = yield* Database
      const repository = yield* AuthorizedShareRepository
      const created = Schema.encodeSync(UtcTimestamp)(createdAt)
      yield* sql`INSERT INTO entity_revisions (
          workspace_id, entity_id, revision, source_revision, normalization_schema_version,
          source_url, first_observed_at, last_observed_at, synchronized_at, created_at
        ) VALUES (
          ${workspaceId}, ${entityId}, 2, '1002', 1, 'https://jira.example/browse/PAY-42',
          ${created}, ${created}, ${created}, ${created}
        )`
      yield* sql`UPDATE entities SET current_revision = 2 WHERE workspace_id = ${workspaceId} AND entity_id = ${entityId}`

      const attempted = yield* repository.create(createInput(secondShareId)).pipe(Effect.result)

      assert.isTrue(Result.isFailure(attempted))
      if (Result.isFailure(attempted)) assert.instanceOf(attempted.failure, PersistenceOperationError)
    })))
})
