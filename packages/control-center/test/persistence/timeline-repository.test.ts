import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert, describe, it } from "@effect/vitest"
import { renderTimelineQueries } from "@knpkv/control-center-sql"
import { Effect, Layer, Schema } from "effect"

import { EntityId, WorkspaceId } from "../../src/domain/identifiers.js"
import { UtcTimestamp } from "../../src/domain/utcTimestamp.js"
import { Database, databaseLayer } from "../../src/server/persistence/Database.js"
import { TimelineRepository } from "../../src/server/persistence/repositories/timelineRepository.js"
import { makePersistenceTestConfig } from "./fixtures.js"

const workspaceId = Schema.decodeSync(WorkspaceId)("01890f6f-6d6a-7cc0-98d2-000000000141")
const newestAt = Schema.decodeSync(UtcTimestamp)("2026-07-17T12:00:00.000Z")
const olderAt = Schema.decodeSync(UtcTimestamp)("2026-07-17T11:00:00.000Z")
const newestEventId = "01890f6f-6d6a-7cc0-98d2-000000000142"
const olderEventId = "01890f6f-6d6a-7cc0-98d2-000000000143"
const detailAuditEventId = "shared-audit-event"
const detailSyncEventDigest = "3".repeat(64)
const detailRelationshipEventDigest = "4".repeat(64)
const detailDomainEventId = "shared-domain-event"
const wrongWorkspaceId = Schema.decodeSync(WorkspaceId)("01890f6f-6d6a-7cc0-98d2-000000000199")
const ExplainQueryPlanRow = Schema.Struct({ detail: Schema.String })

const detailWorkspaces = [
  {
    workspaceId,
    entityId: Schema.decodeSync(EntityId)("01890f6f-6d6a-7cc0-98d2-00000000014a"),
    suffix: "payments",
    displayName: "Payments",
    providerId: "jira",
    connectionLabel: "Payments Jira",
    personLabel: "Avery Bell",
    secretMarker: "PAYMENTS_TIMELINE_PAYLOAD_SECRET"
  },
  {
    workspaceId: Schema.decodeSync(WorkspaceId)("01890f6f-6d6a-7cc0-98d2-000000000149"),
    entityId: Schema.decodeSync(EntityId)("01890f6f-6d6a-7cc0-98d2-00000000014b"),
    suffix: "identity",
    displayName: "Identity",
    providerId: "confluence",
    connectionLabel: "Identity Confluence",
    personLabel: "Jordan Lee",
    secretMarker: "IDENTITY_TIMELINE_PAYLOAD_SECRET"
  }
] satisfies ReadonlyArray<{
  readonly workspaceId: typeof workspaceId
  readonly entityId: EntityId
  readonly suffix: string
  readonly displayName: string
  readonly providerId: "jira" | "confluence"
  readonly connectionLabel: string
  readonly personLabel: string
  readonly secretMarker: string
}>

const withRepository = <Success, Failure>(
  use: Effect.Effect<Success, Failure, Database | TimelineRepository>
) =>
  Effect.gen(function*() {
    const config = yield* makePersistenceTestConfig("control-center-timeline-repository-")
    const database = databaseLayer(config)
    return yield* use.pipe(Effect.provide(TimelineRepository.layer.pipe(Layer.provideMerge(database))))
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped)

const seedSystemEvents = Effect.gen(function*() {
  const { sql } = yield* Database
  const newest = Schema.encodeSync(UtcTimestamp)(newestAt)
  const older = Schema.encodeSync(UtcTimestamp)(olderAt)
  yield* sql`INSERT INTO workspaces (workspace_id, display_name, revision, created_at, updated_at)
    VALUES (${workspaceId}, 'Payments', 1, ${older}, ${newest})`
  yield* sql`INSERT INTO domain_events (
      workspace_id, event_cursor, event_id, schema_version, event_type, dedupe_key,
      job_id, occurred_at, ingested_at, payload_json, payload_digest
    ) VALUES
      (${workspaceId}, 1, ${olderEventId}, 1, 'release-indexed', 'older',
        NULL, ${older}, ${older}, '{}', ${"a".repeat(64)}),
      (${workspaceId}, 2, ${newestEventId}, 1, 'release-evaluated', 'newest',
        'agent-job-42', ${newest}, ${newest}, '{}', ${"b".repeat(64)})`
})

const seedCollidingLegacyPluginPageKeys = Effect.gen(function*() {
  const { sql } = yield* Database
  const committedAt = Schema.encodeSync(UtcTimestamp)(newestAt)
  const connectionId = "connection-source-id"
  yield* sql`INSERT INTO plugin_connections (
      workspace_id, plugin_connection_id, provider_id, display_name, revision,
      is_enabled, created_at, updated_at
    ) VALUES (
      ${workspaceId}, ${connectionId}, 'jira', 'Jira production', 1,
      1, ${committedAt}, ${committedAt}
    )`
  yield* sql`INSERT INTO plugin_sync_streams (
      workspace_id, plugin_connection_id, provider_id, stream_key, revision
    ) VALUES
      (${workspaceId}, ${connectionId}, 'jira', 'a:b', 0),
      (${workspaceId}, ${connectionId}, 'jira', 'a', 0)`
  yield* sql`INSERT INTO plugin_sync_pages (
      workspace_id, plugin_connection_id, stream_key, page_id, expected_revision,
      page_digest, checkpoint_digest, timeline_event_digest, event_count, committed_at
    ) VALUES
      (${workspaceId}, ${connectionId}, 'a:b', 'c', 0,
        ${"c".repeat(64)}, ${"d".repeat(64)}, ${"1".repeat(64)}, 0, ${committedAt}),
      (${workspaceId}, ${connectionId}, 'a', 'b:c', 0,
        ${"e".repeat(64)}, ${"f".repeat(64)}, ${"2".repeat(64)}, 0, ${committedAt})`
})

const seedTimelineDetailSources = Effect.gen(function*() {
  const { sql } = yield* Database
  const occurredAt = Schema.encodeSync(UtcTimestamp)(newestAt)

  yield* Effect.forEach(detailWorkspaces, (fixture) =>
    Effect.gen(function*() {
      const connectionId = `connection-${fixture.suffix}`
      const entityId = fixture.entityId
      const releaseId = `release-${fixture.suffix}`
      const personId = `person-${fixture.suffix}`
      const agentId = `agent-${fixture.suffix}`
      const agentJobId = `agent-job-${fixture.suffix}`
      const actionId = `action-${fixture.suffix}`
      const transitionId = `transition-${fixture.suffix}`
      const relationshipId = `relationship-${fixture.suffix}`
      const sourceNodeId = `source-node-${fixture.suffix}`
      const targetNodeId = `target-node-${fixture.suffix}`
      const envelopeDigest = `sha256:${"5".repeat(64)}`
      const transitionDigest = `sha256:${"6".repeat(64)}`

      yield* sql`INSERT INTO workspaces (
        workspace_id, display_name, revision, created_at, updated_at
      ) VALUES (${fixture.workspaceId}, ${fixture.displayName}, 1, ${occurredAt}, ${occurredAt})`
      yield* sql`INSERT INTO plugin_connections (
        workspace_id, plugin_connection_id, provider_id, display_name,
        revision, is_enabled, created_at, updated_at
      ) VALUES (
        ${fixture.workspaceId}, ${connectionId}, ${fixture.providerId}, ${fixture.connectionLabel},
        1, 1, ${occurredAt}, ${occurredAt}
      )`
      yield* sql`INSERT INTO entities (
        workspace_id, entity_id, plugin_connection_id, provider_id, vendor_immutable_id,
        entity_type, current_revision, created_at, updated_at
      ) VALUES (
        ${fixture.workspaceId}, ${entityId}, ${connectionId}, ${fixture.providerId},
        ${`vendor-${fixture.suffix}`}, 'issue', 1, ${occurredAt}, ${occurredAt}
      )`
      yield* sql`INSERT INTO entity_revisions (
        workspace_id, entity_id, revision, source_revision, normalization_schema_version,
        source_url, first_observed_at, last_observed_at, synchronized_at, created_at
      ) VALUES (
        ${fixture.workspaceId}, ${entityId}, 1, 'source-1', 1, NULL,
        ${occurredAt}, ${occurredAt}, ${occurredAt}, ${occurredAt}
      )`
      yield* sql`INSERT INTO releases (
        workspace_id, release_id, current_revision, created_at, updated_at
      ) VALUES (${fixture.workspaceId}, ${releaseId}, 1, ${occurredAt}, ${occurredAt})`
      yield* sql`INSERT INTO persons (
        workspace_id, person_id, display_name, avatar_json, is_active,
        revision, created_at, updated_at
      ) VALUES (
        ${fixture.workspaceId}, ${personId}, ${fixture.personLabel},
        ${JSON.stringify({ _tag: "initials", text: "TL" })}, 1, 1, ${occurredAt}, ${occurredAt}
      )`

      yield* sql`INSERT INTO governed_actions (
        workspace_id, action_id, plugin_connection_id, provider_id, target_entity_id,
        idempotency_key, envelope_digest, envelope_json, state, lineage_json,
        lineage_kind, provider_operation_id, reconciliation_key, terminal_status,
        head_transition_id, head_sequence, created_at, updated_at
      ) VALUES (
        ${fixture.workspaceId}, ${actionId}, ${connectionId}, ${fixture.providerId}, ${entityId},
        ${`idempotency-${fixture.suffix}`}, ${envelopeDigest},
        ${JSON.stringify({ secret: fixture.secretMarker })}, NULL, NULL,
        NULL, NULL, NULL, NULL, NULL, NULL, ${occurredAt}, ${occurredAt}
      )`
      yield* sql`INSERT INTO governed_action_transitions (
        workspace_id, action_id, transition_id, previous_transition_id, sequence,
        command_id, command_tag, authorization_id, attempt_id, outcome_source_kind,
        command_provider_operation_id, command_reconciliation_key, command_terminal_status,
        command_unknown_kind, command_digest, transition_digest, envelope_digest,
        from_state, to_state, result_lineage_json, result_lineage_kind,
        result_provider_operation_id, result_reconciliation_key, result_terminal_status,
        cause_kind, cause_actor_id, cause_session_id, cause_job_id, cause_system_component,
        causation_id, correlation_id, transition_json, occurred_at
      ) VALUES (
        ${fixture.workspaceId}, ${actionId}, ${transitionId}, NULL, 1,
        ${`command-${fixture.suffix}`}, 'propose', NULL, NULL, NULL,
        NULL, NULL, NULL, NULL, ${`sha256:${"7".repeat(64)}`}, ${transitionDigest}, ${envelopeDigest},
        NULL, 'proposed', '{}', 'none', NULL, NULL, NULL,
        'agent', ${agentId}, NULL, ${agentJobId}, NULL,
        NULL, NULL, ${JSON.stringify({ secret: fixture.secretMarker })}, ${occurredAt}
      )`
      yield* sql`INSERT INTO audit_events (
        workspace_id, action_id, transition_id, audit_event_id, event_kind,
        cause_kind, actor_id, session_id, job_id, system_component, causation_id,
        correlation_id, payload_digest, payload_json, occurred_at
      ) VALUES (
        ${fixture.workspaceId}, ${actionId}, ${transitionId}, ${detailAuditEventId}, 'proposed',
        'agent', ${agentId}, NULL, ${agentJobId}, NULL, NULL,
        NULL, ${transitionDigest}, ${JSON.stringify({ secret: fixture.secretMarker })}, ${occurredAt}
      )`
      yield* sql`UPDATE governed_actions SET
        state = 'proposed', lineage_json = '{}', lineage_kind = 'none',
        head_transition_id = ${transitionId}, head_sequence = 1, updated_at = ${occurredAt}
      WHERE workspace_id = ${fixture.workspaceId} AND action_id = ${actionId}`

      yield* sql`INSERT INTO plugin_sync_streams (
        workspace_id, plugin_connection_id, provider_id, stream_key, revision,
        checkpoint_json, checkpoint_digest, last_page_id, synchronized_at
      ) VALUES (
        ${fixture.workspaceId}, ${connectionId}, ${fixture.providerId}, 'timeline-detail', 1,
        ${JSON.stringify({ secret: fixture.secretMarker })}, ${"8".repeat(64)}, 'detail-page', ${occurredAt}
      )`
      yield* sql`INSERT INTO plugin_sync_pages (
        workspace_id, plugin_connection_id, stream_key, page_id, expected_revision,
        page_digest, checkpoint_digest, timeline_event_digest, event_count, committed_at
      ) VALUES (
        ${fixture.workspaceId}, ${connectionId}, 'timeline-detail', 'detail-page', 0,
        ${"9".repeat(64)}, ${"8".repeat(64)}, ${detailSyncEventDigest}, 1, ${occurredAt}
      )`

      yield* sql`INSERT INTO delivery_nodes (
        workspace_id, node_id, node_key_digest, node_kind, endpoint_kind,
        resolution_state, entity_id, release_id, environment_id, expected_entity_kind,
        missing_key, created_at
      ) VALUES
        (${fixture.workspaceId}, ${sourceNodeId}, ${"a".repeat(64)}, 'entity', 'issue',
          'resolved', ${entityId}, NULL, NULL, NULL, NULL, ${occurredAt}),
        (${fixture.workspaceId}, ${targetNodeId}, ${"b".repeat(64)}, 'entity', 'issue',
          'missing', NULL, NULL, NULL, 'issue', ${`missing-target-${fixture.suffix}`}, ${occurredAt})`
      yield* sql`INSERT INTO relationship_heads (
        workspace_id, relationship_id, current_revision, edge_digest, created_at, updated_at
      ) VALUES (
        ${fixture.workspaceId}, ${relationshipId}, 1, ${"c".repeat(64)}, ${occurredAt}, ${occurredAt}
      )`
      yield* sql`INSERT INTO relationship_revisions (
        workspace_id, relationship_id, revision, supersedes_revision, schema_version,
        kind, source_node_id, source_node_kind, target_node_id, target_node_kind,
        lifecycle, lifecycle_reason, release_id, environment_id,
        confidence_kind, confidence_score, confidence_rationale,
        provenance_kind, provenance_plugin_connection_id, provenance_source_entity_id,
        provenance_source_entity_revision, provenance_person_id, provenance_agent_id,
        provenance_rule_id, provenance_rule_version, provenance_rationale,
        recorded_by_kind, recorded_by_person_id, recorded_by_agent_id, recorded_by_component,
        effective_at, recorded_at, revision_digest
      ) VALUES (
        ${fixture.workspaceId}, ${relationshipId}, 1, NULL, 1,
        'depends-on', ${sourceNodeId}, 'issue', ${targetNodeId}, 'issue',
        'verified', NULL, ${releaseId}, NULL,
        'confirmed', NULL, NULL,
        'plugin', ${connectionId}, ${entityId}, 1, NULL, NULL,
        NULL, NULL, ${fixture.secretMarker},
        'human', ${personId}, NULL, NULL,
        ${occurredAt}, ${occurredAt}, ${detailRelationshipEventDigest}
      )`

      yield* sql`INSERT INTO domain_events (
        workspace_id, event_cursor, event_id, schema_version, event_type, dedupe_key,
        release_id, plugin_connection_id, entity_id, job_id,
        occurred_at, ingested_at, payload_json, payload_digest
      ) VALUES (
        ${fixture.workspaceId}, 1, ${detailDomainEventId}, 1, 'release-evaluated',
        ${`domain-detail-${fixture.suffix}`}, ${releaseId}, ${connectionId}, ${entityId},
        ${agentJobId}, ${occurredAt}, ${occurredAt},
        ${JSON.stringify({ secret: fixture.secretMarker })}, ${"d".repeat(64)}
      )`
    }), { discard: true })
})

describe("TimelineRepository", () => {
  it.effect("merges newest-first rows and applies actor and stable cursor filters", () =>
    withRepository(Effect.gen(function*() {
      yield* seedSystemEvents
      const repository = yield* TimelineRepository
      const first = yield* repository.page({
        actorKind: "system",
        before: null,
        entityId: null,
        from: null,
        limit: 1,
        to: null,
        workspaceId
      })
      assert.deepStrictEqual(first.map(({ eventKey }) => eventKey), [
        `domain:${newestEventId}`,
        `domain:${olderEventId}`
      ])
      const firstEvent = first[0]
      if (firstEvent === undefined) return yield* Effect.die("Timeline fixture did not return its newest event")

      const second = yield* repository.page({
        actorKind: "system",
        before: { eventKey: firstEvent.eventKey, occurredAt: newestAt },
        entityId: null,
        from: null,
        limit: 1,
        to: null,
        workspaceId
      })
      assert.deepStrictEqual(second.map(({ eventKey }) => eventKey), [`domain:${olderEventId}`])

      const human = yield* repository.page({
        actorKind: "human",
        before: null,
        entityId: null,
        from: null,
        limit: 10,
        to: null,
        workspaceId
      })
      assert.deepStrictEqual(human, [])
    })))

  it.effect("paginates delimiter-ambiguous plugin pages with distinct redacted keys", () =>
    withRepository(Effect.gen(function*() {
      yield* seedSystemEvents
      yield* seedCollidingLegacyPluginPageKeys
      const repository = yield* TimelineRepository
      const first = yield* repository.page({
        actorKind: "plugin",
        before: null,
        entityId: null,
        from: null,
        limit: 1,
        to: null,
        workspaceId
      })
      assert.deepStrictEqual(first.map(({ eventKey }) => eventKey), [
        `sync:${"2".repeat(64)}`,
        `sync:${"1".repeat(64)}`
      ])
      assert.isFalse(
        first.some(({ eventKey }) =>
          eventKey.includes("connection-source-id") || eventKey.includes("a:b") || eventKey.includes("b:c")
        )
      )
      const firstEvent = first[0]
      if (firstEvent === undefined) return yield* Effect.die("Timeline fixture did not return its first plugin event")

      const second = yield* repository.page({
        actorKind: "plugin",
        before: { eventKey: firstEvent.eventKey, occurredAt: newestAt },
        entityId: null,
        from: null,
        limit: 1,
        to: null,
        workspaceId
      })
      assert.deepStrictEqual(second.map(({ eventKey }) => eventKey), [`sync:${"1".repeat(64)}`])
    })))

  it.effect("returns only attributable activity for the exact workspace entity", () =>
    withRepository(Effect.gen(function*() {
      yield* seedTimelineDetailSources
      const repository = yield* TimelineRepository
      const paymentsWorkspace = detailWorkspaces[0]
      const identityWorkspace = detailWorkspaces[1]
      if (paymentsWorkspace === undefined || identityWorkspace === undefined) {
        return yield* Effect.die("Timeline entity activity fixtures are incomplete")
      }
      const paymentsEntityId = paymentsWorkspace.entityId
      const identityEntityId = identityWorkspace.entityId
      const absentEntityId = Schema.decodeSync(EntityId)("01890f6f-6d6a-7cc0-98d2-00000000014c")

      const payments = yield* repository.page({
        actorKind: null,
        before: null,
        entityId: paymentsEntityId,
        from: null,
        limit: 20,
        to: null,
        workspaceId: paymentsWorkspace.workspaceId
      })
      assert.deepStrictEqual(
        payments.map(({ eventKey }) => eventKey).sort(),
        [
          `audit:${detailAuditEventId}`,
          `domain:${detailDomainEventId}`,
          `relationship:${detailRelationshipEventDigest}`
        ].sort()
      )
      assert.isTrue(payments.every(({ entityId }) => entityId === paymentsEntityId))
      assert.isFalse(payments.some(({ sourceKind }) => sourceKind === "plugin-sync"))

      const absent = yield* repository.page({
        actorKind: null,
        before: null,
        entityId: absentEntityId,
        from: null,
        limit: 20,
        to: null,
        workspaceId: paymentsWorkspace.workspaceId
      })
      assert.deepStrictEqual(absent, [])

      const identity = yield* repository.page({
        actorKind: null,
        before: null,
        entityId: identityEntityId,
        from: null,
        limit: 20,
        to: null,
        workspaceId: identityWorkspace.workspaceId
      })
      assert.lengthOf(identity, 3)
      assert.isTrue(identity.every(({ entityId }) => entityId === identityEntityId))
    })))

  it.effect("resolves exact source details without crossing workspace boundaries", () =>
    withRepository(Effect.gen(function*() {
      yield* seedTimelineDetailSources
      const repository = yield* TimelineRepository
      const detailKeys = {
        audit: `audit:${detailAuditEventId}`,
        sync: `sync:${detailSyncEventDigest}`,
        relationship: `relationship:${detailRelationshipEventDigest}`,
        domain: `domain:${detailDomainEventId}`
      } satisfies Record<"audit" | "sync" | "relationship" | "domain", string>
      const resolvedDetails = yield* Effect.forEach(detailWorkspaces, (fixture) =>
        Effect.gen(function*() {
          const connectionId = `connection-${fixture.suffix}`
          const entityId = fixture.entityId
          const releaseId = `release-${fixture.suffix}`
          const actionId = `action-${fixture.suffix}`
          const relationshipId = `relationship-${fixture.suffix}`
          const agentId = `agent-${fixture.suffix}`
          const agentJobId = `agent-job-${fixture.suffix}`
          const personId = `person-${fixture.suffix}`
          const details = yield* Effect.all({
            audit: repository.detail({ eventKey: detailKeys.audit, workspaceId: fixture.workspaceId }),
            sync: repository.detail({ eventKey: detailKeys.sync, workspaceId: fixture.workspaceId }),
            relationship: repository.detail({
              eventKey: detailKeys.relationship,
              workspaceId: fixture.workspaceId
            }),
            domain: repository.detail({ eventKey: detailKeys.domain, workspaceId: fixture.workspaceId })
          })

          assert.deepStrictEqual(details.audit, {
            eventKey: detailKeys.audit,
            occurredAt: newestAt,
            actorKind: "agent",
            actorId: agentId,
            actorLabel: null,
            eventType: "proposed",
            sourceKind: "action",
            service: null,
            releaseId: null,
            entityId,
            actionId,
            relationshipId: null,
            pluginConnectionId: connectionId,
            agentJobId
          })
          assert.deepStrictEqual(details.sync, {
            eventKey: detailKeys.sync,
            occurredAt: newestAt,
            actorKind: "plugin",
            actorId: connectionId,
            actorLabel: fixture.connectionLabel,
            eventType: "synchronized",
            sourceKind: "plugin-sync",
            service: fixture.providerId,
            releaseId: null,
            entityId: null,
            actionId: null,
            relationshipId: null,
            pluginConnectionId: connectionId,
            agentJobId: null
          })
          assert.deepStrictEqual(details.relationship, {
            eventKey: detailKeys.relationship,
            occurredAt: newestAt,
            actorKind: "human",
            actorId: personId,
            actorLabel: fixture.personLabel,
            eventType: "verified",
            sourceKind: "relationship",
            service: null,
            releaseId,
            entityId: null,
            actionId: null,
            relationshipId,
            pluginConnectionId: connectionId,
            agentJobId: null
          })
          assert.deepStrictEqual(details.domain, {
            eventKey: detailKeys.domain,
            occurredAt: newestAt,
            actorKind: "system",
            actorId: null,
            actorLabel: "Control Center",
            eventType: "release-evaluated",
            sourceKind: "system",
            service: null,
            releaseId,
            entityId,
            actionId: null,
            relationshipId: null,
            pluginConnectionId: connectionId,
            agentJobId
          })
          return details
        }))

      assert.notDeepEqual(resolvedDetails[0], resolvedDetails[1])
      for (const eventKey of Object.values(detailKeys)) {
        const wrongWorkspace = yield* repository.detail({ eventKey, workspaceId: wrongWorkspaceId })
        assert.isNull(wrongWorkspace)
      }

      const serializedDetails = JSON.stringify(resolvedDetails)
      for (const { secretMarker } of detailWorkspaces) {
        assert.notInclude(serializedDetails, secretMarker)
      }
    })))

  it.effect("uses source-specific workspace-time indexes without temporary Timeline sorts", () =>
    withRepository(Effect.gen(function*() {
      const { sql } = yield* Database
      const plans = renderTimelineQueries({
        actorKind: null,
        before: null,
        entityId: null,
        from: "2026-07-01T00:00:00.000Z",
        limit: 25,
        to: "2026-07-31T23:59:59.999Z",
        workspaceId
      })
      const expectedIndexes: Readonly<Record<"action" | "plugin-sync" | "relationship" | "system", string>> = {
        action: "governed_action_audit_timeline_idx",
        "plugin-sync": "plugin_sync_pages_timeline_idx",
        relationship: "relationship_revision_timeline_idx",
        system: "domain_events_timeline_idx"
      }

      for (const plan of plans) {
        const rows = yield* sql.unsafe(`EXPLAIN QUERY PLAN ${plan.sql}`, [...plan.params]).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(ExplainQueryPlanRow)))
        )
        const details = rows.map(({ detail }) => detail).join("\n")
        assert.include(details, expectedIndexes[plan.sourceKind])
        assert.notInclude(details, "USE TEMP B-TREE FOR ORDER BY")
      }

      const rowsWithoutIndex = yield* sql.unsafe(
        `EXPLAIN QUERY PLAN
          SELECT event_id
          FROM domain_events NOT INDEXED
          WHERE workspace_id = ?
          ORDER BY occurred_at DESC, event_id DESC
          LIMIT ?`,
        [workspaceId, 25]
      ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(ExplainQueryPlanRow))))
      assert.include(
        rowsWithoutIndex.map(({ detail }) => detail).join("\n"),
        "USE TEMP B-TREE FOR ORDER BY"
      )
    })))
})
