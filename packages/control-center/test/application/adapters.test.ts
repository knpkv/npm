import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert, describe, it } from "@effect/vitest"
import { Context, Effect, Layer, Option, Ref, Result, Schema, Stream } from "effect"
import * as DateTime from "effect/DateTime"
import * as TestClock from "effect/testing/TestClock"

import {
  OpaqueMediaId,
  OpaqueSecretReference,
  PluginConfigurationKey,
  PluginConnectionTestResult
} from "../../src/api/index.js"
import { derivePersonInitials, Person } from "../../src/domain/actors.js"
import { LedgerRevision } from "../../src/domain/deliveryGraph.js"
import {
  EnvironmentId,
  PersonId,
  PluginConnectionId,
  RelationshipId,
  RelationshipRepairProposalId,
  RelationshipRepairReviewId,
  ReleaseId,
  RoleAssignmentId,
  SessionId,
  WorkspaceId
} from "../../src/domain/identifiers.js"
import { NegotiatedPluginDescriptorV1 } from "../../src/domain/plugins/descriptor.js"
import { Release } from "../../src/domain/release.js"
import { deriveReleaseRelay } from "../../src/domain/releaseRelay.js"
import type { ProviderId } from "../../src/domain/sourceRevision.js"
import { UtcTimestamp } from "../../src/domain/utcTimestamp.js"
import {
  ApplicationConflict,
  ApplicationInvalidRequest,
  ApplicationResourceNotFound,
  ApplicationServiceUnavailable
} from "../../src/server/api/ApplicationServices.js"
import {
  listFirstPartyServiceMetadata,
  makeDeliveryGraphInspection,
  makeMediaReads,
  makePluginAdministration,
  makePluginAdministrationWithConnections,
  makePortfolioSnapshots,
  makeRelationshipRepairProposals,
  mapPersistenceReadError
} from "../../src/server/application/index.js"
import { Database, databaseLayer } from "../../src/server/persistence/Database.js"
import { BlobNotFoundError } from "../../src/server/persistence/object-store/BlobStoreError.js"
import { Persistence, persistenceLayerFromDatabase } from "../../src/server/persistence/Persistence.js"
import { PluginConnectionDisplayName, WorkspaceName } from "../../src/server/persistence/repositories/models.js"
import { StoredPluginConfiguration } from "../../src/server/persistence/repositories/pluginConfigurationModels.js"
import { firstPartyService } from "../../src/server/plugins/catalog/firstPartyServiceCatalog.js"
import { PluginAuthenticationFailure } from "../../src/server/plugins/failures.js"
import { negotiatePluginDescriptorV1 } from "../../src/server/plugins/negotiation.js"
import { PluginConnection } from "../../src/server/plugins/PluginConnection.js"
import type { PluginConnectionV1 } from "../../src/server/plugins/PluginConnection.js"
import type { PluginConnectionMapV1 } from "../../src/server/plugins/PluginConnectionMap.js"
import { SecretRef } from "../../src/server/secrets/SecretRef.js"
import { SecretRoot, SecretStore } from "../../src/server/secrets/SecretStore.js"
import { makePersistenceTestConfig } from "../persistence/fixtures.js"

const WORKSPACE_ID = Schema.decodeSync(WorkspaceId)("01890f6f-6d6a-7cc0-98d2-000000000071")
const OTHER_WORKSPACE_ID = Schema.decodeSync(WorkspaceId)("01890f6f-6d6a-7cc0-98d2-000000000072")
const PLUGIN_ID = Schema.decodeSync(PluginConnectionId)("01890f6f-6d6a-7cc0-98d2-000000000073")
const UNREADY_PLUGIN_ID = Schema.decodeSync(PluginConnectionId)("01890f6f-6d6a-7cc0-98d2-000000000074")
const CONFLUENCE_PLUGIN_ID = Schema.decodeSync(PluginConnectionId)("01890f6f-6d6a-7cc0-98d2-00000000008b")
const CODEPIPELINE_PLUGIN_ID = Schema.decodeSync(PluginConnectionId)("01890f6f-6d6a-7cc0-98d2-00000000008c")
const PROVISIONED_PLUGIN_ID = Schema.decodeSync(PluginConnectionId)("01890f6f-6d6a-7cc0-98d2-00000000008d")
const INVALID_PLUGIN_ID = Schema.decodeSync(PluginConnectionId)("01890f6f-6d6a-7cc0-98d2-00000000008e")
const FAILED_PLUGIN_ID = Schema.decodeSync(PluginConnectionId)("01890f6f-6d6a-7cc0-98d2-00000000008f")
const RELEASE_ID = Schema.decodeSync(ReleaseId)("01890f6f-6d6a-7cc0-98d2-000000000075")
const ENVIRONMENT_ID = Schema.decodeSync(EnvironmentId)("01890f6f-6d6a-7cc0-98d2-000000000076")
const RELATIONSHIP_ID = Schema.decodeSync(RelationshipId)("01890f6f-6d6a-7cc0-98d2-000000000077")
const REPAIR_PROPOSAL_ID = Schema.decodeSync(RelationshipRepairProposalId)(
  "01890f6f-6d6a-7cc0-98d2-000000000079"
)
const OTHER_REPAIR_PROPOSAL_ID = Schema.decodeSync(RelationshipRepairProposalId)(
  "01890f6f-6d6a-7cc0-98d2-00000000007a"
)
const OWNER_SESSION_ID = Schema.decodeSync(SessionId)("01890f6f-6d6a-7cc0-98d2-00000000007b")
const OWNER_PERSON_ID = Schema.decodeSync(PersonId)("01890f6f-6d6a-7cc0-98d2-00000000007c")
const WATCHER_SESSION_ID = Schema.decodeSync(SessionId)("01890f6f-6d6a-7cc0-98d2-00000000007d")
const WATCHER_PERSON_ID = Schema.decodeSync(PersonId)("01890f6f-6d6a-7cc0-98d2-00000000007e")
const APPROVER_SESSION_ID = Schema.decodeSync(SessionId)("01890f6f-6d6a-7cc0-98d2-000000000081")
const APPROVER_PERSON_ID = Schema.decodeSync(PersonId)("01890f6f-6d6a-7cc0-98d2-000000000082")
const REPAIR_REVIEW_ID = Schema.decodeSync(RelationshipRepairReviewId)(
  "01890f6f-6d6a-7cc0-98d2-000000000083"
)
const OTHER_REPAIR_REVIEW_ID = Schema.decodeSync(RelationshipRepairReviewId)(
  "01890f6f-6d6a-7cc0-98d2-000000000084"
)
const STALE_APPLY_RELATIONSHIP_ID = Schema.decodeSync(RelationshipId)(
  "01890f6f-6d6a-7cc0-98d2-000000000085"
)
const STALE_APPLY_PROPOSAL_ID = Schema.decodeSync(RelationshipRepairProposalId)(
  "01890f6f-6d6a-7cc0-98d2-000000000086"
)
const STALE_APPLY_REVIEW_ID = Schema.decodeSync(RelationshipRepairReviewId)(
  "01890f6f-6d6a-7cc0-98d2-000000000087"
)
const APPLICATION_PAGE_REVIEW_ID = Schema.decodeSync(RelationshipRepairReviewId)(
  "01890f6f-6d6a-7cc0-98d2-000000000088"
)
const OTHER_RELEASE_ID = Schema.decodeSync(ReleaseId)("01890f6f-6d6a-7cc0-98d2-000000000078")
const RELATIONSHIP_REVISION = Schema.decodeSync(LedgerRevision)(1)
const T0 = Schema.decodeSync(UtcTimestamp)("2026-07-14T10:00:00.000Z")
const SNAPSHOT_AT = Schema.decodeSync(UtcTimestamp)("2026-07-14T10:10:00.000Z")
const BACKDATED_APPLY_AT = Schema.decodeSync(UtcTimestamp)("2026-07-14T10:05:00.000Z")
const APPLICATION_PAGE_FILLER_COUNT = 127
const APPLICATION_PAGE_PROPOSED_AT_TEXT = "2026-07-14T10:20:00.000Z"
const APPLICATION_PAGE_PROPOSED_AT = Schema.decodeSync(UtcTimestamp)(APPLICATION_PAGE_PROPOSED_AT_TEXT)
const APPLICATION_PAGE_APPLIED_AT = Schema.decodeSync(UtcTimestamp)("2026-07-14T10:21:00.000Z")

const epochMillis = (timestamp: UtcTimestamp): number => DateTime.toEpochMillis(timestamp)

const descriptor = {
  contractId: "dev.knpkv.control-center.plugin",
  contractVersion: { major: 1, minor: 0, patch: 0 },
  pluginId: "dev.knpkv.jira",
  adapterVersion: { major: 2, minor: 1, patch: 0 },
  displayName: "Jira",
  configurationFields: [
    {
      _tag: "text",
      key: "site",
      label: "Site",
      description: "Atlassian site name",
      required: true
    },
    {
      _tag: "select",
      key: "project",
      label: "Project",
      description: "Default Jira project",
      required: true,
      options: [{ label: "Payments", value: "PAY" }]
    },
    {
      _tag: "secret-reference",
      key: "token",
      label: "Token",
      description: "API token reference",
      required: true,
      secretKind: "token"
    }
  ],
  capabilities: [{ capabilityId: "entity.read", supportedVersions: [1], requirement: "required" }]
}

const negotiatedDescriptor = Schema.decodeUnknownSync(NegotiatedPluginDescriptorV1)({
  descriptor,
  capabilities: [{ capabilityId: "entity.read", version: 1 }]
})

const release = Schema.decodeSync(Release)({
  createdAt: "2026-07-14T10:00:00.000Z",
  freshness: {
    _tag: "missing",
    pluginHealth: { _tag: "healthy", checkedAt: "2026-07-14T10:01:00.000Z" },
    provenance: { _tag: "none", pluginConnectionId: PLUGIN_ID },
    sourceObservedAt: null,
    staleAfterSeconds: 300,
    synchronizedAt: "2026-07-14T10:01:00.000Z"
  },
  id: RELEASE_ID,
  lifecycle: "candidate",
  relay: deriveReleaseRelay(RELEASE_ID),
  roleAssignments: [],
  serviceName: "payments-api",
  sourceRevisions: [],
  targetEnvironmentIds: [ENVIRONMENT_ID],
  updatedAt: "2026-07-14T10:01:00.000Z",
  version: "2.18.0-rc.1",
  workspaceId: WORKSPACE_ID
})

const currentRelease = Schema.decodeSync(Release)({
  ...Schema.encodeSync(Release)(release),
  freshness: {
    _tag: "current",
    pluginHealth: { _tag: "healthy", checkedAt: "2026-07-14T10:01:00.000Z" },
    provenance: {
      _tag: "provider",
      sourceRevision: {
        pluginConnectionId: PLUGIN_ID,
        providerId: "jira",
        vendorImmutableId: "release-42",
        revision: "release-r1",
        normalizationSchemaVersion: 1,
        sourceUrl: null,
        firstObservedAt: "2026-07-14T10:00:00.000Z",
        lastObservedAt: "2026-07-14T10:00:00.000Z",
        synchronizedAt: "2026-07-14T10:01:00.000Z"
      }
    },
    sourceObservedAt: "2026-07-14T10:00:00.000Z",
    staleAfterSeconds: 300,
    synchronizedAt: "2026-07-14T10:01:00.000Z"
  },
  sourceRevisions: [{
    pluginConnectionId: PLUGIN_ID,
    providerId: "jira",
    vendorImmutableId: "release-42",
    revision: "release-r1",
    normalizationSchemaVersion: 1,
    sourceUrl: null,
    firstObservedAt: "2026-07-14T10:00:00.000Z",
    lastObservedAt: "2026-07-14T10:00:00.000Z",
    synchronizedAt: "2026-07-14T10:01:00.000Z"
  }]
})

const withApplication = <Success, Failure>(
  use: Effect.Effect<Success, Failure, Database | Persistence | SecretStore>
) =>
  Effect.gen(function*() {
    const config = yield* makePersistenceTestConfig("control-center-application-")
    const secretRoot = SecretRoot.make(`${config.blobRoot.slice(0, -"/blobs".length)}/secrets`)
    const database = databaseLayer(config)
    const applicationDependencies = Layer.mergeAll(
      database,
      persistenceLayerFromDatabase(config).pipe(Layer.provide(database)),
      SecretStore.layer({ secretRoot })
    )
    return yield* use.pipe(Effect.provide(applicationDependencies))
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped)

const setup = Effect.gen(function*() {
  const database = yield* Database
  const persistence = yield* Persistence
  yield* persistence.workspaces.create(WORKSPACE_ID, {
    displayName: WorkspaceName.make("Payments"),
    createdAt: T0
  })
  yield* persistence.workspaces.create(OTHER_WORKSPACE_ID, {
    displayName: WorkspaceName.make("Other"),
    createdAt: T0
  })
  yield* persistence.people.createPerson(
    WORKSPACE_ID,
    Schema.decodeSync(Person)({
      personId: OWNER_PERSON_ID,
      displayName: "Release Owner",
      avatar: { _tag: "initials", text: "RO" },
      isActive: true,
      sourceIdentities: []
    }),
    T0
  )
  yield* persistence.people.createPerson(
    WORKSPACE_ID,
    Schema.decodeSync(Person)({
      personId: APPROVER_PERSON_ID,
      displayName: "Release Approver",
      avatar: { _tag: "initials", text: "RA" },
      isActive: true,
      sourceIdentities: []
    }),
    T0
  )
  yield* database.sql`INSERT INTO sessions (
    workspace_id, session_id, token_hash, csrf_hash, actor_kind, person_id,
    agent_id, permission, created_at, last_seen_at, idle_expires_at,
    absolute_expires_at, revoked_at
  ) VALUES (
    ${WORKSPACE_ID}, ${OWNER_SESSION_ID}, ${"ab".repeat(32)}, ${"cd".repeat(32)},
    'human', ${OWNER_PERSON_ID}, NULL, 'workspace-owner',
    '2026-07-14T10:00:00.000Z', '2026-07-14T10:01:00.000Z',
    '2026-07-31T00:00:00.000Z', '2026-08-31T00:00:00.000Z', NULL
  )`
  yield* database.sql`INSERT INTO sessions (
    workspace_id, session_id, token_hash, csrf_hash, actor_kind, person_id,
    agent_id, permission, created_at, last_seen_at, idle_expires_at,
    absolute_expires_at, revoked_at
  ) VALUES (
    ${WORKSPACE_ID}, ${APPROVER_SESSION_ID}, ${"12".repeat(32)}, ${"34".repeat(32)},
    'human', ${APPROVER_PERSON_ID}, NULL, 'workspace-approver',
    '2026-07-14T10:00:00.000Z', '2026-07-14T10:01:00.000Z',
    '2026-07-31T00:00:00.000Z', '2026-08-31T00:00:00.000Z', NULL
  )`
  yield* database.sql`INSERT INTO sessions (
    workspace_id, session_id, token_hash, csrf_hash, actor_kind, person_id,
    agent_id, permission, created_at, last_seen_at, idle_expires_at,
    absolute_expires_at, revoked_at
  ) VALUES (
    ${WORKSPACE_ID}, ${WATCHER_SESSION_ID}, ${"ef".repeat(32)}, ${"01".repeat(32)},
    'human', ${WATCHER_PERSON_ID}, NULL, 'watcher',
    '2026-07-14T10:00:00.000Z', '2026-07-14T10:01:00.000Z',
    '2026-07-31T00:00:00.000Z', '2026-08-31T00:00:00.000Z', NULL
  )`
  yield* persistence.pluginConnections.create(WORKSPACE_ID, {
    pluginConnectionId: PLUGIN_ID,
    providerId: "jira",
    displayName: PluginConnectionDisplayName.make("Payments Jira"),
    isEnabled: true,
    createdAt: T0
  })
  yield* persistence.pluginConnections.create(WORKSPACE_ID, {
    pluginConnectionId: UNREADY_PLUGIN_ID,
    providerId: "jira",
    displayName: PluginConnectionDisplayName.make("Unready Jira"),
    isEnabled: false,
    createdAt: T0
  })
  yield* persistence.pluginRuntime.acceptPluginDescriptor(
    WORKSPACE_ID,
    PLUGIN_ID,
    "jira",
    descriptor,
    0,
    T0
  )
  return persistence
})

describe("application adapters", () => {
  it("exposes the fixed five first-party services before any connection exists", () => {
    assert.deepStrictEqual(
      listFirstPartyServiceMetadata().map(({ displayName, providerId }) => ({ displayName, providerId })),
      [
        { displayName: "CodeCommit", providerId: "codecommit" },
        { displayName: "CodePipeline", providerId: "codepipeline" },
        { displayName: "Jira", providerId: "jira" },
        { displayName: "Confluence", providerId: "confluence" },
        { displayName: "Clockify", providerId: "clockify" }
      ]
    )
  })

  it.effect("keeps setup fields aligned with every canonical runtime descriptor", () =>
    Effect.gen(function*() {
      const providerIds: ReadonlyArray<ProviderId> = ["codecommit", "codepipeline", "jira", "confluence", "clockify"]
      for (const providerId of providerIds) {
        const catalog = firstPartyService(providerId)
        assert.isDefined(catalog)
        if (catalog === undefined) continue
        const descriptor = yield* negotiatePluginDescriptorV1(catalog.rawDescriptor)
        assert.deepStrictEqual(
          catalog.metadata.configurationFields.map(({ key, kind }) => ({ key, kind })),
          descriptor.descriptor.configurationFields.map(({ _tag, key }) => ({
            key,
            kind: _tag === "secret-reference" ? "secret" : _tag
          }))
        )
      }
    }))

  it.effect("creates secrets, disabled metadata, canonical configuration, descriptor, enablement, and identity in order", () =>
    withApplication(Effect.gen(function*() {
      yield* setup
      const invalidations = yield* Ref.make(0)
      const connection: PluginConnectionV1 = {
        descriptor: negotiatedDescriptor,
        discover: Effect.succeed({
          account: { providerImmutableId: "atlassian-account-789", displayName: "Provisioned Owner" },
          workspace: { providerImmutableId: "site-789", displayName: "Provisioned Jira" },
          endpoints: [],
          discoveredAt: T0
        }),
        health: Effect.succeed({ _tag: "healthy", checkedAt: T0 }),
        sync: () => Stream.die("not used"),
        readEntity: () => Effect.die("not used"),
        diff: Option.none(),
        proposeAction: () => Effect.die("not used")
      }
      const pluginConnections: PluginConnectionMapV1 = {
        contextEffect: ({ pluginConnectionId, workspaceId }) =>
          workspaceId === WORKSPACE_ID && [
              PROVISIONED_PLUGIN_ID,
              CONFLUENCE_PLUGIN_ID,
              CODEPIPELINE_PLUGIN_ID
            ].includes(pluginConnectionId)
            ? Effect.succeed(Context.make(PluginConnection, connection))
            : Effect.die("provisioning crossed its requested scope"),
        invalidate: () => Ref.update(invalidations, (count) => count + 1)
      }
      const administration = yield* makePluginAdministrationWithConnections(pluginConnections)
      const operation = administration.connectAndTest
      assert.isDefined(operation)
      const response = yield* operation({
        workspaceId: WORKSPACE_ID,
        request: {
          pluginConnectionId: PROVISIONED_PLUGIN_ID,
          providerId: "jira",
          displayName: "Provisioned Jira",
          values: [
            { _tag: "url", key: PluginConfigurationKey.make("webBaseUrl"), value: "https://knpkv.atlassian.net/" },
            { _tag: "text", key: PluginConfigurationKey.make("email"), value: "owner@example.com" },
            { _tag: "secret", key: PluginConfigurationKey.make("apiToken"), value: "plaintext-token-canary" }
          ]
        }
      })

      assert.isTrue(response.connection.isEnabled)
      assert.strictEqual(response.connection.providerId, "jira")
      assert.strictEqual(response.configuration.revision, 1)
      assert.deepInclude(response.configuration.values, {
        _tag: "secret-reference",
        key: PluginConfigurationKey.make("apiToken"),
        state: "configured"
      })
      assert.deepInclude(response.configuration.values, {
        _tag: "secret-reference",
        key: PluginConfigurationKey.make("email"),
        state: "configured"
      })
      assert.deepInclude(response.configuration.values, {
        _tag: "url",
        key: PluginConfigurationKey.make("webBaseUrl"),
        value: "https://knpkv.atlassian.net/"
      })
      assert.strictEqual(response.test._tag, "healthy")
      if (response.test._tag === "healthy") {
        assert.strictEqual(response.test.identity.displayName, "Provisioned Owner")
        assert.strictEqual(response.test.identity.providerImmutableId, "atlassian-account-789")
      }
      assert.strictEqual(yield* Ref.get(invalidations), 1)

      const persistence = yield* Persistence
      const record = yield* persistence.pluginConnections.get(WORKSPACE_ID, PROVISIONED_PLUGIN_ID)
      assert.isTrue(record.isEnabled)
      assert.strictEqual(record.revision, 2)
      const runtime = yield* persistence.pluginRuntime.getRuntime(WORKSPACE_ID, PROVISIONED_PLUGIN_ID)
      assert.include(runtime.descriptorJson, "apiToken")
      const database = yield* Database
      const rows = yield* database.sql<{ readonly configurationJson: string }>`SELECT
        configuration_json AS configurationJson
        FROM plugin_configurations
        WHERE workspace_id = ${WORKSPACE_ID} AND plugin_connection_id = ${PROVISIONED_PLUGIN_ID}`
      assert.lengthOf(rows, 1)
      assert.notInclude(rows[0]?.configurationJson ?? "", "plaintext-token-canary")
      assert.notInclude(rows[0]?.configurationJson ?? "", "owner@example.com")
      assert.notInclude(JSON.stringify(response), "plaintext-token-canary")
      assert.notInclude(JSON.stringify(response), "owner@example.com")
      assert.notMatch(JSON.stringify(response), /secret_[0-9a-f]{64}/u)

      const currentConfiguration = yield* persistence.pluginConfigurations.get(WORKSPACE_ID, PROVISIONED_PLUGIN_ID)
      assert.isTrue(Option.isSome(currentConfiguration))
      if (Option.isSome(currentConfiguration)) {
        const legacyConfiguration = yield* Schema.decodeUnknownEffect(StoredPluginConfiguration)(
          currentConfiguration.value.values.map((value) =>
            value.key === "email"
              ? { _tag: "text", key: "email", value: "legacy-owner@example.com" }
              : value
          )
        )
        yield* persistence.pluginConfigurations.update(
          WORKSPACE_ID,
          PROVISIONED_PLUGIN_ID,
          legacyConfiguration,
          currentConfiguration.value.revision,
          T0
        )
        const legacyRead = yield* administration.configuration({
          workspaceId: WORKSPACE_ID,
          pluginConnectionId: PROVISIONED_PLUGIN_ID
        })
        assert.deepInclude(legacyRead.values, {
          _tag: "secret-reference",
          key: PluginConfigurationKey.make("email"),
          state: "configured"
        })
        assert.notInclude(JSON.stringify(legacyRead), "legacy-owner@example.com")
      }

      const confluence = yield* operation({
        workspaceId: WORKSPACE_ID,
        request: {
          pluginConnectionId: CONFLUENCE_PLUGIN_ID,
          providerId: "confluence",
          displayName: "Provisioned Confluence",
          values: [
            { _tag: "url", key: PluginConfigurationKey.make("siteBaseUrl"), value: "https://knpkv.atlassian.net/" },
            { _tag: "text", key: PluginConfigurationKey.make("email"), value: "docs@example.com" },
            { _tag: "secret", key: PluginConfigurationKey.make("apiToken"), value: "confluence-token-canary" },
            { _tag: "text", key: PluginConfigurationKey.make("siteId"), value: "site-1" },
            { _tag: "text", key: PluginConfigurationKey.make("spaceId"), value: "space-1" },
            { _tag: "text", key: PluginConfigurationKey.make("probePageId"), value: "page-1" }
          ]
        }
      })
      assert.deepInclude(confluence.configuration.values, {
        _tag: "secret-reference",
        key: PluginConfigurationKey.make("email"),
        state: "configured"
      })
      assert.deepInclude(confluence.configuration.values, {
        _tag: "text",
        key: PluginConfigurationKey.make("spaceId"),
        value: "space-1"
      })
      assert.notInclude(JSON.stringify(confluence), "docs@example.com")

      const codeCommit = yield* operation({
        workspaceId: WORKSPACE_ID,
        request: {
          pluginConnectionId: CODEPIPELINE_PLUGIN_ID,
          providerId: "codecommit",
          displayName: "Provisioned CodeCommit",
          values: [
            { _tag: "text", key: PluginConfigurationKey.make("profile"), value: "delivery" },
            { _tag: "text", key: PluginConfigurationKey.make("region"), value: "eu-west-1" },
            { _tag: "text", key: PluginConfigurationKey.make("repositoryName"), value: "payments" }
          ]
        }
      })
      assert.deepInclude(codeCommit.configuration.values, {
        _tag: "text",
        key: PluginConfigurationKey.make("profile"),
        value: "delivery"
      })
      assert.strictEqual(yield* Ref.get(invalidations), 3)
    })))

  it.effect("retains a visible disabled durable draft when no runtime map is installed", () =>
    withApplication(Effect.gen(function*() {
      yield* setup
      const administration = yield* makePluginAdministration
      const operation = administration.connectAndTest
      assert.isDefined(operation)
      const result = yield* operation({
        workspaceId: WORKSPACE_ID,
        request: {
          pluginConnectionId: PROVISIONED_PLUGIN_ID,
          providerId: "codecommit",
          displayName: "Draft CodeCommit",
          values: [
            { _tag: "text", key: PluginConfigurationKey.make("profile"), value: "default" },
            { _tag: "text", key: PluginConfigurationKey.make("region"), value: "eu-west-1" },
            { _tag: "text", key: PluginConfigurationKey.make("repositoryName"), value: "payments" }
          ]
        }
      }).pipe(Effect.result)
      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) assert.instanceOf(result.failure, ApplicationServiceUnavailable)

      const persistence = yield* Persistence
      const draft = yield* persistence.pluginConnections.get(WORKSPACE_ID, PROVISIONED_PLUGIN_ID)
      assert.isFalse(draft.isEnabled)
      assert.isTrue(Option.isSome(yield* persistence.pluginConfigurations.get(WORKSPACE_ID, PROVISIONED_PLUGIN_ID)))
      const metadata = yield* administration.configurationMetadata({
        workspaceId: WORKSPACE_ID,
        pluginConnectionId: PROVISIONED_PLUGIN_ID
      })
      assert.strictEqual(metadata.pluginId, "dev.knpkv.codecommit")
    })))

  it.effect("rejects missing and unknown catalog fields before creating metadata", () =>
    withApplication(Effect.gen(function*() {
      yield* setup
      const administration = yield* makePluginAdministration
      const operation = administration.connectAndTest
      assert.isDefined(operation)
      const missing = yield* operation({
        workspaceId: WORKSPACE_ID,
        request: {
          pluginConnectionId: INVALID_PLUGIN_ID,
          providerId: "codecommit",
          displayName: "Invalid CodeCommit",
          values: [{ _tag: "text", key: PluginConfigurationKey.make("region"), value: "eu-west-1" }]
        }
      }).pipe(Effect.result)
      assert.isTrue(Result.isFailure(missing))
      if (Result.isFailure(missing)) assert.instanceOf(missing.failure, ApplicationInvalidRequest)

      const unknown = yield* operation({
        workspaceId: WORKSPACE_ID,
        request: {
          pluginConnectionId: INVALID_PLUGIN_ID,
          providerId: "codecommit",
          displayName: "Invalid CodeCommit",
          values: [
            { _tag: "text", key: PluginConfigurationKey.make("profile"), value: "default" },
            { _tag: "text", key: PluginConfigurationKey.make("region"), value: "eu-west-1" },
            { _tag: "text", key: PluginConfigurationKey.make("repositoryName"), value: "payments" },
            { _tag: "text", key: PluginConfigurationKey.make("unknown"), value: "unexpected" }
          ]
        }
      }).pipe(Effect.result)
      assert.isTrue(Result.isFailure(unknown))
      if (Result.isFailure(unknown)) assert.instanceOf(unknown.failure, ApplicationInvalidRequest)

      const invalidProviderValues: ReadonlyArray<{
        readonly email: string
        readonly webBaseUrl: string
      }> = [
        { webBaseUrl: "https://example.com/", email: "owner@example.com" },
        { webBaseUrl: "https://knpkv.atlassian.net/", email: "malformed-email" }
      ]
      for (const invalid of invalidProviderValues) {
        const providerInvalid = yield* operation({
          workspaceId: WORKSPACE_ID,
          request: {
            pluginConnectionId: INVALID_PLUGIN_ID,
            providerId: "jira",
            displayName: "Invalid Jira",
            values: [
              { _tag: "url", key: PluginConfigurationKey.make("webBaseUrl"), value: invalid.webBaseUrl },
              { _tag: "text", key: PluginConfigurationKey.make("email"), value: invalid.email },
              { _tag: "secret", key: PluginConfigurationKey.make("apiToken"), value: "must-not-be-persisted" }
            ]
          }
        }).pipe(Effect.result)
        assert.isTrue(Result.isFailure(providerInvalid))
        if (Result.isFailure(providerInvalid)) {
          assert.instanceOf(providerInvalid.failure, ApplicationInvalidRequest)
        }
      }

      const persistence = yield* Persistence
      assert.isTrue(Result.isFailure(
        yield* persistence.pluginConnections.get(WORKSPACE_ID, INVALID_PLUGIN_ID).pipe(Effect.result)
      ))
      assert.isTrue(Option.isNone(
        yield* persistence.pluginConfigurations.get(WORKSPACE_ID, INVALID_PLUGIN_ID)
      ))
    })))

  it.effect("keeps a provider-authentication test failure as an enabled usable connection", () =>
    withApplication(Effect.gen(function*() {
      yield* setup
      const connection: PluginConnectionV1 = {
        descriptor: negotiatedDescriptor,
        discover: Effect.die("discovery must not run after failed health"),
        health: Effect.fail(new PluginAuthenticationFailure({ operation: "jira-health" })),
        sync: () => Stream.die("not used"),
        readEntity: () => Effect.die("not used"),
        diff: Option.none(),
        proposeAction: () => Effect.die("not used")
      }
      const administration = yield* makePluginAdministrationWithConnections({
        contextEffect: () => Effect.succeed(Context.make(PluginConnection, connection)),
        invalidate: () => Effect.void
      })
      const operation = administration.connectAndTest
      assert.isDefined(operation)
      const response = yield* operation({
        workspaceId: WORKSPACE_ID,
        request: {
          pluginConnectionId: FAILED_PLUGIN_ID,
          providerId: "jira",
          displayName: "Rejected Jira",
          values: [
            { _tag: "url", key: PluginConfigurationKey.make("webBaseUrl"), value: "https://knpkv.atlassian.net/" },
            { _tag: "text", key: PluginConfigurationKey.make("email"), value: "owner@example.com" },
            { _tag: "secret", key: PluginConfigurationKey.make("apiToken"), value: "rejected-token-canary" }
          ]
        }
      })
      assert.strictEqual(response.test._tag, "failed")
      assert.isTrue(response.connection.isEnabled)
      assert.notInclude(JSON.stringify(response), "rejected-token-canary")
      const persistence = yield* Persistence
      assert.isTrue((yield* persistence.pluginConnections.get(WORKSPACE_ID, FAILED_PLUGIN_ID)).isEnabled)
    })))

  it.effect("removes newly-created secrets when metadata creation fails before durable configuration", () =>
    withApplication(Effect.gen(function*() {
      yield* setup
      const creates = yield* Ref.make(0)
      const removals = yield* Ref.make(0)
      const reference = SecretRef.make(`secret_${"a".repeat(64)}`)
      const instrumentedSecrets = SecretStore.of({
        create: () => Ref.update(creates, (count) => count + 1).pipe(Effect.as(reference)),
        remove: () => Ref.update(removals, (count) => count + 1),
        resolve: () => Effect.die("precommit cleanup test must not resolve a secret"),
        rotate: () => Effect.die("precommit cleanup test must not rotate a secret")
      })
      const result = yield* Effect.gen(function*() {
        const administration = yield* makePluginAdministration
        const operation = administration.connectAndTest
        assert.isDefined(operation)
        return yield* operation({
          workspaceId: WORKSPACE_ID,
          request: {
            pluginConnectionId: PLUGIN_ID,
            providerId: "jira",
            displayName: "Duplicate Jira",
            values: [
              { _tag: "url", key: PluginConfigurationKey.make("webBaseUrl"), value: "https://knpkv.atlassian.net/" },
              { _tag: "text", key: PluginConfigurationKey.make("email"), value: "owner@example.com" },
              { _tag: "secret", key: PluginConfigurationKey.make("apiToken"), value: "temporary-token" }
            ]
          }
        }).pipe(Effect.result)
      }).pipe(Effect.provideService(SecretStore, instrumentedSecrets))

      assert.isTrue(Result.isFailure(result))
      assert.strictEqual(yield* Ref.get(creates), 2)
      assert.strictEqual(yield* Ref.get(removals), 2)
    })))

  it.effect("inspects only a workspace-owned release graph without substituting demo data", () =>
    withApplication(Effect.gen(function*() {
      const persistence = yield* setup
      yield* persistence.releases.create(WORKSPACE_ID, release)
      const inspection = yield* makeDeliveryGraphInspection

      const slice = yield* inspection.releaseSlice({
        workspaceId: WORKSPACE_ID,
        releaseId: RELEASE_ID,
        environmentId: null
      })
      assert.deepStrictEqual(slice, {
        releaseId: RELEASE_ID,
        environmentId: null,
        truncated: false,
        nodes: [],
        entityProjections: [],
        relationships: [],
        evidenceClaims: [],
        evidenceItems: []
      })
      const candidates = yield* inspection.repairCandidates({
        workspaceId: WORKSPACE_ID,
        releaseId: RELEASE_ID,
        environmentId: null
      })
      assert.deepStrictEqual(candidates, {
        releaseId: RELEASE_ID,
        environmentId: null,
        truncated: false,
        candidates: []
      })

      const missingDraft = yield* inspection.repairProposalDraft({
        workspaceId: WORKSPACE_ID,
        releaseId: RELEASE_ID,
        environmentId: null,
        relationshipId: RELATIONSHIP_ID,
        revision: RELATIONSHIP_REVISION
      }).pipe(Effect.result)
      assert.isTrue(Result.isFailure(missingDraft))
      if (Result.isFailure(missingDraft)) {
        assert.instanceOf(missingDraft.failure, ApplicationResourceNotFound)
      }

      const crossWorkspace = yield* inspection.releaseSlice({
        workspaceId: OTHER_WORKSPACE_ID,
        releaseId: RELEASE_ID,
        environmentId: null
      }).pipe(Effect.result)
      assert.isTrue(Result.isFailure(crossWorkspace))
      if (Result.isFailure(crossWorkspace)) {
        assert.instanceOf(crossWorkspace.failure, ApplicationResourceNotFound)
      }
    })))

  it.effect("drafts only the exact current repair head within its workspace and release scope", () =>
    withApplication(Effect.gen(function*() {
      const persistence = yield* setup
      const database = yield* Database
      yield* persistence.releases.create(WORKSPACE_ID, release)
      yield* persistence.releases.create(
        WORKSPACE_ID,
        Schema.decodeSync(Release)({
          ...Schema.encodeSync(Release)(release),
          id: OTHER_RELEASE_ID,
          relay: deriveReleaseRelay(OTHER_RELEASE_ID),
          version: "2.19.0-rc.1"
        })
      )
      const releaseNodeId = "01890f6f-6d6a-7cc0-98d2-600000000001"
      const issueNodeId = "01890f6f-6d6a-7cc0-98d2-600000000002"
      const staleIssueNodeId = "01890f6f-6d6a-7cc0-98d2-600000000003"
      const firstRevision = {
        workspaceId: WORKSPACE_ID,
        relationshipId: RELATIONSHIP_ID,
        relationshipSchemaVersion: 1,
        revision: 1,
        supersedesRevision: null,
        kind: "contains",
        sourceNodeId: releaseNodeId,
        sourceNodeKind: "release",
        targetNodeId: issueNodeId,
        targetNodeKind: "issue",
        scope: { _tag: "release", releaseId: RELEASE_ID },
        lifecycle: {
          _tag: "missing",
          effectiveAt: "2026-07-14T10:00:00.000Z",
          reason: "The release issue is not linked."
        },
        confidence: { _tag: "unknown", rationale: "No source relationship was observed." },
        provenance: {
          _tag: "rule",
          ruleId: "missing-release-issue",
          ruleVersion: 1,
          rationale: "Every release issue must be linked."
        },
        recordedBy: { _tag: "system", component: "candidate-test" },
        evidenceClaimIds: [],
        recordedAt: "2026-07-14T10:00:00.000Z"
      }
      const staleFirstRevision = {
        ...firstRevision,
        relationshipId: STALE_APPLY_RELATIONSHIP_ID,
        targetNodeId: staleIssueNodeId
      }
      yield* persistence.deliveryGraph.write(WORKSPACE_ID, {
        entityProjections: [],
        nodes: [
          {
            workspaceId: WORKSPACE_ID,
            nodeId: releaseNodeId,
            endpointKind: "release",
            resolution: { _tag: "resolved", target: { _tag: "release", releaseId: RELEASE_ID } },
            createdAt: "2026-07-14T10:00:00.000Z"
          },
          {
            workspaceId: WORKSPACE_ID,
            nodeId: issueNodeId,
            endpointKind: "issue",
            resolution: {
              _tag: "missing",
              expectedKind: "entity",
              expectedEntityKind: "issue",
              missingKey: "release:missing-issue"
            },
            createdAt: "2026-07-14T10:00:00.000Z"
          },
          {
            workspaceId: WORKSPACE_ID,
            nodeId: staleIssueNodeId,
            endpointKind: "issue",
            resolution: {
              _tag: "missing",
              expectedKind: "entity",
              expectedEntityKind: "issue",
              missingKey: "release:stale-apply-issue"
            },
            createdAt: "2026-07-14T10:00:00.000Z"
          }
        ],
        evidenceItems: [],
        evidenceClaims: [],
        relationships: [firstRevision, staleFirstRevision]
      })

      const fillerNodes = Array.from({ length: 500 }, (_, index) => ({
        workspaceId: WORKSPACE_ID,
        nodeId: `01890f6f-6d6a-7cc0-98d2-${String(610_000_000_000 + index).padStart(12, "0")}`,
        endpointKind: "issue",
        resolution: {
          _tag: "missing",
          expectedKind: "entity",
          expectedEntityKind: "issue",
          missingKey: `release:filler-issue:${index}`
        },
        createdAt: "2026-07-14T10:00:30.000Z"
      }))
      const fillerRelationships = fillerNodes.map((node, index) => ({
        workspaceId: WORKSPACE_ID,
        relationshipId: `01890f6f-6d6a-7cc0-98d2-${String(510_000_000_000 + index).padStart(12, "0")}`,
        relationshipSchemaVersion: 1,
        revision: 1,
        supersedesRevision: null,
        kind: "contains",
        sourceNodeId: releaseNodeId,
        sourceNodeKind: "release",
        targetNodeId: node.nodeId,
        targetNodeKind: "issue",
        scope: { _tag: "release", releaseId: RELEASE_ID },
        lifecycle: { _tag: "governed", effectiveAt: "2026-07-14T10:00:30.000Z" },
        confidence: { _tag: "unknown", rationale: "This filler does not carry evidence." },
        provenance: {
          _tag: "rule",
          ruleId: "release-filler",
          ruleVersion: 1,
          rationale: "A newer unrelated release relationship."
        },
        recordedBy: { _tag: "system", component: "candidate-test" },
        evidenceClaimIds: [],
        recordedAt: "2026-07-14T10:00:30.000Z"
      }))
      yield* Effect.forEach(
        Array.from({ length: 5 }, (_, index) => fillerNodes.slice(index * 100, (index + 1) * 100)),
        (nodes) =>
          persistence.deliveryGraph.write(WORKSPACE_ID, {
            entityProjections: [],
            nodes,
            evidenceItems: [],
            evidenceClaims: [],
            relationships: []
          }),
        { discard: true }
      )
      yield* Effect.forEach(
        Array.from({ length: 5 }, (_, index) => fillerRelationships.slice(index * 100, (index + 1) * 100)),
        (relationships) =>
          persistence.deliveryGraph.write(WORKSPACE_ID, {
            entityProjections: [],
            nodes: [],
            evidenceItems: [],
            evidenceClaims: [],
            relationships
          }),
        { discard: true }
      )

      const inspection = yield* makeDeliveryGraphInspection
      const boundedCandidates = yield* inspection.repairCandidates({
        workspaceId: WORKSPACE_ID,
        releaseId: RELEASE_ID,
        environmentId: null
      })
      assert.isTrue(boundedCandidates.truncated)
      assert.isFalse(
        boundedCandidates.candidates.some(({ relationship }) => relationship.relationshipId === RELATIONSHIP_ID)
      )
      const revisionOneDraft = yield* inspection.repairProposalDraft({
        workspaceId: WORKSPACE_ID,
        releaseId: RELEASE_ID,
        environmentId: null,
        relationshipId: RELATIONSHIP_ID,
        revision: RELATIONSHIP_REVISION
      })
      assert.strictEqual(revisionOneDraft.precondition.expectedRevision, RELATIONSHIP_REVISION)

      yield* persistence.deliveryGraph.write(WORKSPACE_ID, {
        entityProjections: [],
        nodes: [],
        evidenceItems: [],
        evidenceClaims: [],
        relationships: [firstRevision, staleFirstRevision].map((relationship) => ({
          ...relationship,
          revision: 2,
          supersedesRevision: 1,
          lifecycle: { _tag: "proposed", effectiveAt: "2026-07-14T10:01:00.000Z" },
          recordedAt: "2026-07-14T10:01:00.000Z"
        }))
      })
      const stale = yield* inspection.repairProposalDraft({
        workspaceId: WORKSPACE_ID,
        releaseId: RELEASE_ID,
        environmentId: null,
        relationshipId: RELATIONSHIP_ID,
        revision: RELATIONSHIP_REVISION
      }).pipe(Effect.result)
      const wrongEnvironment = yield* inspection.repairProposalDraft({
        workspaceId: WORKSPACE_ID,
        releaseId: RELEASE_ID,
        environmentId: ENVIRONMENT_ID,
        relationshipId: RELATIONSHIP_ID,
        revision: Schema.decodeSync(LedgerRevision)(2)
      }).pipe(Effect.result)
      const crossWorkspace = yield* inspection.repairProposalDraft({
        workspaceId: OTHER_WORKSPACE_ID,
        releaseId: RELEASE_ID,
        environmentId: null,
        relationshipId: RELATIONSHIP_ID,
        revision: Schema.decodeSync(LedgerRevision)(2)
      }).pipe(Effect.result)
      const wrongRelease = yield* inspection.repairProposalDraft({
        workspaceId: WORKSPACE_ID,
        releaseId: OTHER_RELEASE_ID,
        environmentId: null,
        relationshipId: RELATIONSHIP_ID,
        revision: Schema.decodeSync(LedgerRevision)(2)
      }).pipe(Effect.result)
      for (const result of [stale, wrongEnvironment, crossWorkspace, wrongRelease]) {
        assert.isTrue(Result.isFailure(result))
        if (Result.isFailure(result)) assert.instanceOf(result.failure, ApplicationResourceNotFound)
      }
      const current = yield* inspection.repairProposalDraft({
        workspaceId: WORKSPACE_ID,
        releaseId: RELEASE_ID,
        environmentId: null,
        relationshipId: RELATIONSHIP_ID,
        revision: Schema.decodeSync(LedgerRevision)(2)
      })
      assert.strictEqual(current.precondition.expectedRevision, 2)

      yield* TestClock.setTime(epochMillis(SNAPSHOT_AT))
      const repairProposals = yield* makeRelationshipRepairProposals
      const rejectedWatcher = yield* repairProposals.create({
        workspaceId: WORKSPACE_ID,
        releaseId: RELEASE_ID,
        relationshipId: RELATIONSHIP_ID,
        request: {
          proposalId: REPAIR_PROPOSAL_ID,
          environmentId: null,
          expectedRevision: Schema.decodeSync(LedgerRevision)(2),
          disposition: current.proposal.disposition,
          rationale: current.proposal.rationale
        },
        actor: { _tag: "human", personId: WATCHER_PERSON_ID },
        sessionId: WATCHER_SESSION_ID
      }).pipe(Effect.result)
      assert.isTrue(Result.isFailure(rejectedWatcher))
      if (Result.isFailure(rejectedWatcher)) {
        assert.instanceOf(rejectedWatcher.failure, ApplicationServiceUnavailable)
      }
      const absentAfterRejectedAuthority = yield* repairProposals.get({
        workspaceId: WORKSPACE_ID,
        proposalId: REPAIR_PROPOSAL_ID
      }).pipe(Effect.result)
      assert.isTrue(Result.isFailure(absentAfterRejectedAuthority))
      if (Result.isFailure(absentAfterRejectedAuthority)) {
        assert.instanceOf(absentAfterRejectedAuthority.failure, ApplicationResourceNotFound)
      }

      const created = yield* repairProposals.create({
        workspaceId: WORKSPACE_ID,
        releaseId: RELEASE_ID,
        relationshipId: RELATIONSHIP_ID,
        request: {
          proposalId: REPAIR_PROPOSAL_ID,
          environmentId: null,
          expectedRevision: Schema.decodeSync(LedgerRevision)(2),
          disposition: current.proposal.disposition,
          rationale: current.proposal.rationale
        },
        actor: { _tag: "human", personId: OWNER_PERSON_ID },
        sessionId: OWNER_SESSION_ID
      })
      assert.strictEqual(created.status, "pending")
      assert.strictEqual(created.schemaVersion, 2)
      assert.isNull(created.review)
      assert.strictEqual(created.origin.sessionId, OWNER_SESSION_ID)
      assert.deepStrictEqual(
        yield* repairProposals.get({ workspaceId: WORKSPACE_ID, proposalId: REPAIR_PROPOSAL_ID }),
        created
      )

      const replayed = yield* repairProposals.create({
        workspaceId: WORKSPACE_ID,
        releaseId: RELEASE_ID,
        relationshipId: RELATIONSHIP_ID,
        request: {
          proposalId: REPAIR_PROPOSAL_ID,
          environmentId: null,
          expectedRevision: Schema.decodeSync(LedgerRevision)(2),
          disposition: current.proposal.disposition,
          rationale: current.proposal.rationale
        },
        actor: { _tag: "human", personId: OWNER_PERSON_ID },
        sessionId: OWNER_SESSION_ID
      })
      assert.deepStrictEqual(replayed, created)

      const competing = yield* repairProposals.create({
        workspaceId: WORKSPACE_ID,
        releaseId: RELEASE_ID,
        relationshipId: RELATIONSHIP_ID,
        request: {
          proposalId: OTHER_REPAIR_PROPOSAL_ID,
          environmentId: null,
          expectedRevision: Schema.decodeSync(LedgerRevision)(2),
          disposition: "reject",
          rationale: "Reject this candidate instead."
        },
        actor: { _tag: "human", personId: OWNER_PERSON_ID },
        sessionId: OWNER_SESSION_ID
      }).pipe(Effect.result)
      assert.isTrue(Result.isFailure(competing))
      if (Result.isFailure(competing)) assert.instanceOf(competing.failure, ApplicationConflict)

      const pendingPage = yield* repairProposals.list({
        workspaceId: WORKSPACE_ID,
        releaseId: RELEASE_ID,
        environmentId: null,
        status: "pending"
      })
      assert.deepStrictEqual(pendingPage.proposals.map(({ proposalId }) => proposalId), [REPAIR_PROPOSAL_ID])
      assert.deepStrictEqual(pendingPage.applications, [])

      const pendingApplication = yield* repairProposals.apply({
        workspaceId: WORKSPACE_ID,
        proposalId: REPAIR_PROPOSAL_ID,
        actor: { _tag: "human", personId: OWNER_PERSON_ID },
        sessionId: OWNER_SESSION_ID
      }).pipe(Effect.result)
      assert.isTrue(Result.isFailure(pendingApplication))
      if (Result.isFailure(pendingApplication)) {
        assert.instanceOf(pendingApplication.failure, ApplicationInvalidRequest)
      }

      const selfReview = yield* repairProposals.review({
        workspaceId: WORKSPACE_ID,
        proposalId: REPAIR_PROPOSAL_ID,
        request: {
          reviewId: REPAIR_REVIEW_ID,
          decision: "approved",
          rationale: "The candidate evidence is sufficient."
        },
        actor: { _tag: "human", personId: OWNER_PERSON_ID },
        sessionId: OWNER_SESSION_ID
      }).pipe(Effect.result)
      assert.isTrue(Result.isFailure(selfReview))
      if (Result.isFailure(selfReview)) assert.instanceOf(selfReview.failure, ApplicationConflict)

      const approved = yield* repairProposals.review({
        workspaceId: WORKSPACE_ID,
        proposalId: REPAIR_PROPOSAL_ID,
        request: {
          reviewId: REPAIR_REVIEW_ID,
          decision: "approved",
          rationale: "The candidate evidence is sufficient."
        },
        actor: { _tag: "human", personId: APPROVER_PERSON_ID },
        sessionId: APPROVER_SESSION_ID
      })
      assert.strictEqual(approved.status, "approved")
      assert.strictEqual(approved.review?.origin.sessionId, APPROVER_SESSION_ID)
      assert.deepStrictEqual(
        yield* repairProposals.get({ workspaceId: WORKSPACE_ID, proposalId: REPAIR_PROPOSAL_ID }),
        approved
      )

      const replayedReview = yield* repairProposals.review({
        workspaceId: WORKSPACE_ID,
        proposalId: REPAIR_PROPOSAL_ID,
        request: {
          reviewId: REPAIR_REVIEW_ID,
          decision: "approved",
          rationale: "The candidate evidence is sufficient."
        },
        actor: { _tag: "human", personId: APPROVER_PERSON_ID },
        sessionId: APPROVER_SESSION_ID
      })
      assert.deepStrictEqual(replayedReview, approved)

      const changedReview = yield* repairProposals.review({
        workspaceId: WORKSPACE_ID,
        proposalId: REPAIR_PROPOSAL_ID,
        request: {
          reviewId: OTHER_REPAIR_REVIEW_ID,
          decision: "rejected",
          rationale: "Use a different relationship."
        },
        actor: { _tag: "human", personId: APPROVER_PERSON_ID },
        sessionId: APPROVER_SESSION_ID
      }).pipe(Effect.result)
      assert.isTrue(Result.isFailure(changedReview))
      if (Result.isFailure(changedReview)) assert.instanceOf(changedReview.failure, ApplicationConflict)

      const approvedPage = yield* repairProposals.list({
        workspaceId: WORKSPACE_ID,
        releaseId: RELEASE_ID,
        environmentId: null,
        status: "approved"
      })
      assert.deepStrictEqual(approvedPage.proposals, [approved])

      yield* repairProposals.create({
        workspaceId: WORKSPACE_ID,
        releaseId: RELEASE_ID,
        relationshipId: STALE_APPLY_RELATIONSHIP_ID,
        request: {
          proposalId: STALE_APPLY_PROPOSAL_ID,
          environmentId: null,
          expectedRevision: Schema.decodeSync(LedgerRevision)(2),
          disposition: "verify",
          rationale: "Verify the second inferred link."
        },
        actor: { _tag: "human", personId: OWNER_PERSON_ID },
        sessionId: OWNER_SESSION_ID
      })
      yield* repairProposals.review({
        workspaceId: WORKSPACE_ID,
        proposalId: STALE_APPLY_PROPOSAL_ID,
        request: {
          reviewId: STALE_APPLY_REVIEW_ID,
          decision: "approved",
          rationale: "The second link is ready."
        },
        actor: { _tag: "human", personId: APPROVER_PERSON_ID },
        sessionId: APPROVER_SESSION_ID
      })
      yield* persistence.deliveryGraph.write(WORKSPACE_ID, {
        entityProjections: [],
        nodes: [],
        evidenceItems: [],
        evidenceClaims: [],
        relationships: [{
          ...staleFirstRevision,
          revision: 3,
          supersedesRevision: 2,
          lifecycle: { _tag: "proposed", effectiveAt: "2026-07-14T10:10:00.000Z" },
          recordedAt: "2026-07-14T10:10:00.000Z"
        }]
      })
      const staleHistory = yield* inspection.relationshipHistory({
        workspaceId: WORKSPACE_ID,
        relationshipId: STALE_APPLY_RELATIONSHIP_ID
      })
      const staleApplication = yield* repairProposals.apply({
        workspaceId: WORKSPACE_ID,
        proposalId: STALE_APPLY_PROPOSAL_ID,
        actor: { _tag: "human", personId: OWNER_PERSON_ID },
        sessionId: OWNER_SESSION_ID
      }).pipe(Effect.result)
      assert.isTrue(Result.isFailure(staleApplication))
      if (Result.isFailure(staleApplication)) {
        assert.instanceOf(staleApplication.failure, ApplicationConflict)
      }
      assert.isNull(
        yield* persistence.relationshipRepairProposals.application({
          workspaceId: WORKSPACE_ID,
          proposalId: STALE_APPLY_PROPOSAL_ID
        })
      )
      assert.deepStrictEqual(
        yield* inspection.relationshipHistory({
          workspaceId: WORKSPACE_ID,
          relationshipId: STALE_APPLY_RELATIONSHIP_ID
        }),
        staleHistory
      )

      yield* TestClock.setTime(epochMillis(BACKDATED_APPLY_AT))
      const backdatedApplication = yield* repairProposals.apply({
        workspaceId: WORKSPACE_ID,
        proposalId: REPAIR_PROPOSAL_ID,
        actor: { _tag: "human", personId: OWNER_PERSON_ID },
        sessionId: OWNER_SESSION_ID
      }).pipe(Effect.result)
      assert.isTrue(Result.isFailure(backdatedApplication))
      if (Result.isFailure(backdatedApplication)) {
        assert.instanceOf(backdatedApplication.failure, ApplicationServiceUnavailable)
      }
      yield* TestClock.setTime(epochMillis(SNAPSHOT_AT))

      const unauthorizedApplication = yield* repairProposals.apply({
        workspaceId: WORKSPACE_ID,
        proposalId: REPAIR_PROPOSAL_ID,
        actor: { _tag: "human", personId: APPROVER_PERSON_ID },
        sessionId: APPROVER_SESSION_ID
      }).pipe(Effect.result)
      assert.isTrue(Result.isFailure(unauthorizedApplication))
      if (Result.isFailure(unauthorizedApplication)) {
        assert.instanceOf(unauthorizedApplication.failure, ApplicationServiceUnavailable)
      }
      assert.deepStrictEqual(
        (yield* inspection.relationshipHistory({
          workspaceId: WORKSPACE_ID,
          relationshipId: RELATIONSHIP_ID
        })).revisions.map(({ revision }) => revision),
        [2, 1]
      )
      assert.isNull(
        yield* persistence.relationshipRepairProposals.application({
          workspaceId: WORKSPACE_ID,
          proposalId: REPAIR_PROPOSAL_ID
        })
      )

      const [applied, concurrentReplay] = yield* Effect.all([
        repairProposals.apply({
          workspaceId: WORKSPACE_ID,
          proposalId: REPAIR_PROPOSAL_ID,
          actor: { _tag: "human", personId: OWNER_PERSON_ID },
          sessionId: OWNER_SESSION_ID
        }),
        repairProposals.apply({
          workspaceId: WORKSPACE_ID,
          proposalId: REPAIR_PROPOSAL_ID,
          actor: { _tag: "human", personId: OWNER_PERSON_ID },
          sessionId: OWNER_SESSION_ID
        })
      ], { concurrency: 2 })
      assert.deepStrictEqual(concurrentReplay, applied)
      assert.strictEqual(applied.application.appliedRevision, 3)
      assert.strictEqual(applied.application.origin.sessionId, OWNER_SESSION_ID)
      assert.strictEqual(applied.relationship.revision, 3)
      assert.strictEqual(applied.relationship.supersedesRevision, 2)
      assert.strictEqual(applied.relationship.lifecycle._tag, "verified")
      assert.deepStrictEqual(applied.relationship.recordedBy, {
        _tag: "human",
        personId: OWNER_PERSON_ID
      })
      const appliedPage = yield* repairProposals.list({
        workspaceId: WORKSPACE_ID,
        releaseId: RELEASE_ID,
        environmentId: null,
        status: "approved"
      })
      assert.deepStrictEqual(appliedPage.applications, [applied.application])

      yield* persistence.pluginConnections.create(OTHER_WORKSPACE_ID, {
        pluginConnectionId: PLUGIN_ID,
        providerId: "jira",
        displayName: PluginConnectionDisplayName.make("Other Jira"),
        isEnabled: true,
        createdAt: T0
      })
      yield* persistence.people.createPerson(
        OTHER_WORKSPACE_ID,
        Schema.decodeSync(Person)({
          personId: OWNER_PERSON_ID,
          displayName: "Other Release Owner",
          avatar: { _tag: "initials", text: "OO" },
          isActive: true,
          sourceIdentities: []
        }),
        T0
      )
      yield* persistence.people.createPerson(
        OTHER_WORKSPACE_ID,
        Schema.decodeSync(Person)({
          personId: APPROVER_PERSON_ID,
          displayName: "Other Release Approver",
          avatar: { _tag: "initials", text: "OA" },
          isActive: true,
          sourceIdentities: []
        }),
        T0
      )
      yield* database.sql`INSERT INTO sessions (
        workspace_id, session_id, token_hash, csrf_hash, actor_kind, person_id,
        agent_id, permission, created_at, last_seen_at, idle_expires_at,
        absolute_expires_at, revoked_at
      ) VALUES
        (${OTHER_WORKSPACE_ID}, ${OWNER_SESSION_ID}, ${"56".repeat(32)}, ${"78".repeat(32)},
          'human', ${OWNER_PERSON_ID}, NULL, 'workspace-owner',
          '2026-07-14T10:00:00.000Z', '2026-07-14T10:01:00.000Z',
          '2026-07-31T00:00:00.000Z', '2026-08-31T00:00:00.000Z', NULL),
        (${OTHER_WORKSPACE_ID}, ${APPROVER_SESSION_ID}, ${"9a".repeat(32)}, ${"bc".repeat(32)},
          'human', ${APPROVER_PERSON_ID}, NULL, 'workspace-approver',
          '2026-07-14T10:00:00.000Z', '2026-07-14T10:01:00.000Z',
          '2026-07-31T00:00:00.000Z', '2026-08-31T00:00:00.000Z', NULL)`
      yield* persistence.releases.create(
        OTHER_WORKSPACE_ID,
        Schema.decodeSync(Release)({
          ...Schema.encodeSync(Release)(release),
          workspaceId: OTHER_WORKSPACE_ID
        })
      )
      yield* persistence.deliveryGraph.write(OTHER_WORKSPACE_ID, {
        entityProjections: [],
        nodes: [
          {
            workspaceId: OTHER_WORKSPACE_ID,
            nodeId: releaseNodeId,
            endpointKind: "release",
            resolution: { _tag: "resolved", target: { _tag: "release", releaseId: RELEASE_ID } },
            createdAt: "2026-07-14T10:00:00.000Z"
          },
          {
            workspaceId: OTHER_WORKSPACE_ID,
            nodeId: issueNodeId,
            endpointKind: "issue",
            resolution: {
              _tag: "missing",
              expectedKind: "entity",
              expectedEntityKind: "issue",
              missingKey: "other-release:missing-issue"
            },
            createdAt: "2026-07-14T10:00:00.000Z"
          }
        ],
        evidenceItems: [],
        evidenceClaims: [],
        relationships: [{ ...firstRevision, workspaceId: OTHER_WORKSPACE_ID }]
      })
      yield* repairProposals.create({
        workspaceId: OTHER_WORKSPACE_ID,
        releaseId: RELEASE_ID,
        relationshipId: RELATIONSHIP_ID,
        request: {
          proposalId: REPAIR_PROPOSAL_ID,
          environmentId: null,
          expectedRevision: RELATIONSHIP_REVISION,
          disposition: "verify",
          rationale: "Verify the colliding workspace relationship."
        },
        actor: { _tag: "human", personId: OWNER_PERSON_ID },
        sessionId: OWNER_SESSION_ID
      })
      yield* repairProposals.review({
        workspaceId: OTHER_WORKSPACE_ID,
        proposalId: REPAIR_PROPOSAL_ID,
        request: {
          reviewId: REPAIR_REVIEW_ID,
          decision: "approved",
          rationale: "The colliding workspace evidence is sufficient."
        },
        actor: { _tag: "human", personId: APPROVER_PERSON_ID },
        sessionId: APPROVER_SESSION_ID
      })
      const otherWorkspaceApplication = yield* repairProposals.apply({
        workspaceId: OTHER_WORKSPACE_ID,
        proposalId: REPAIR_PROPOSAL_ID,
        actor: { _tag: "human", personId: OWNER_PERSON_ID },
        sessionId: OWNER_SESSION_ID
      })
      const workspacePages = yield* Effect.all([
        repairProposals.list({
          workspaceId: WORKSPACE_ID,
          releaseId: RELEASE_ID,
          environmentId: null,
          status: "approved"
        }),
        repairProposals.list({
          workspaceId: OTHER_WORKSPACE_ID,
          releaseId: RELEASE_ID,
          environmentId: null,
          status: "approved"
        })
      ], { concurrency: 1 })
      assert.deepStrictEqual(workspacePages[0]?.applications, [applied.application])
      assert.deepStrictEqual(workspacePages[1]?.applications, [otherWorkspaceApplication.application])

      const isolatedApplicationPages = yield* Effect.all([
        repairProposals.list({
          workspaceId: WORKSPACE_ID,
          releaseId: RELEASE_ID,
          environmentId: null,
          status: "pending"
        }),
        repairProposals.list({
          workspaceId: WORKSPACE_ID,
          releaseId: RELEASE_ID,
          environmentId: ENVIRONMENT_ID,
          status: null
        }),
        repairProposals.list({
          workspaceId: WORKSPACE_ID,
          releaseId: OTHER_RELEASE_ID,
          environmentId: null,
          status: null
        })
      ], { concurrency: 1 })
      for (const page of isolatedApplicationPages) assert.deepStrictEqual(page.applications, [])
      const applicationPageRelationships = fillerRelationships.slice(0, APPLICATION_PAGE_FILLER_COUNT).map(
        (relationship) => ({
          ...relationship,
          revision: 2,
          supersedesRevision: 1,
          lifecycle: {
            _tag: "missing",
            effectiveAt: APPLICATION_PAGE_PROPOSED_AT_TEXT,
            reason: "This relationship exists only to exercise the bounded proposal page."
          },
          recordedAt: APPLICATION_PAGE_PROPOSED_AT_TEXT
        })
      )
      yield* persistence.deliveryGraph.write(WORKSPACE_ID, {
        entityProjections: [],
        nodes: [],
        evidenceItems: [],
        evidenceClaims: [],
        relationships: applicationPageRelationships
      })
      yield* Effect.forEach(
        applicationPageRelationships,
        (relationship, index) =>
          persistence.relationshipRepairProposals.create({
            workspaceId: WORKSPACE_ID,
            proposalId: Schema.decodeSync(RelationshipRepairProposalId)(
              `01890f6f-6d6a-7cc0-98d2-${String(520_000_000_000 + index).padStart(12, "0")}`
            ),
            releaseId: RELEASE_ID,
            environmentId: null,
            relationshipId: relationship.relationshipId,
            expectedRevision: LedgerRevision.make(2),
            disposition: "link",
            rationale: "Link the bounded-page fixture relationship.",
            origin: {
              actor: { _tag: "human", personId: OWNER_PERSON_ID },
              sessionId: OWNER_SESSION_ID
            },
            proposedAt: APPLICATION_PAGE_PROPOSED_AT
          }),
        { concurrency: 1, discard: true }
      )
      const inPageProposalId = Schema.decodeSync(RelationshipRepairProposalId)(
        `01890f6f-6d6a-7cc0-98d2-${String(520_000_000_000 + APPLICATION_PAGE_FILLER_COUNT - 1).padStart(12, "0")}`
      )
      yield* TestClock.setTime(epochMillis(APPLICATION_PAGE_APPLIED_AT))
      yield* repairProposals.review({
        workspaceId: WORKSPACE_ID,
        proposalId: inPageProposalId,
        request: {
          reviewId: APPLICATION_PAGE_REVIEW_ID,
          decision: "approved",
          rationale: "The in-page fixture relationship is ready."
        },
        actor: { _tag: "human", personId: APPROVER_PERSON_ID },
        sessionId: APPROVER_SESSION_ID
      })
      const inPageApplication = yield* repairProposals.apply({
        workspaceId: WORKSPACE_ID,
        proposalId: inPageProposalId,
        actor: { _tag: "human", personId: OWNER_PERSON_ID },
        sessionId: OWNER_SESSION_ID
      })
      const boundedPage = yield* repairProposals.list({
        workspaceId: WORKSPACE_ID,
        releaseId: RELEASE_ID,
        environmentId: null,
        status: null
      })
      assert.lengthOf(boundedPage.proposals, 128)
      assert.isTrue(boundedPage.truncated)
      assert.isFalse(boundedPage.proposals.some(({ proposalId }) => proposalId === REPAIR_PROPOSAL_ID))
      assert.deepStrictEqual(boundedPage.applications, [inPageApplication.application])
      assert.deepStrictEqual(
        yield* database.sql`SELECT proposal_id AS proposalId, relationship_id AS relationshipId,
          applied_revision AS appliedRevision
        FROM relationship_repair_applications
        WHERE workspace_id = ${WORKSPACE_ID} AND proposal_id = ${REPAIR_PROPOSAL_ID}`,
        [{
          proposalId: REPAIR_PROPOSAL_ID,
          relationshipId: RELATIONSHIP_ID,
          appliedRevision: 3
        }]
      )
      assert.isTrue(Result.isFailure(
        yield* database.sql`UPDATE relationship_repair_applications
          SET applied_revision = 2
          WHERE workspace_id = ${WORKSPACE_ID} AND proposal_id = ${REPAIR_PROPOSAL_ID}`.pipe(Effect.result)
      ))
      const historyAfterApply = yield* inspection.relationshipHistory({
        workspaceId: WORKSPACE_ID,
        relationshipId: RELATIONSHIP_ID
      })
      assert.deepStrictEqual(historyAfterApply.revisions.map(({ revision }) => revision), [3, 2, 1])

      const staleProposal = yield* repairProposals.create({
        workspaceId: WORKSPACE_ID,
        releaseId: RELEASE_ID,
        relationshipId: RELATIONSHIP_ID,
        request: {
          proposalId: OTHER_REPAIR_PROPOSAL_ID,
          environmentId: null,
          expectedRevision: RELATIONSHIP_REVISION,
          disposition: "link",
          rationale: "This revision is stale."
        },
        actor: { _tag: "human", personId: OWNER_PERSON_ID },
        sessionId: OWNER_SESSION_ID
      }).pipe(Effect.result)
      assert.isTrue(Result.isFailure(staleProposal))
      if (Result.isFailure(staleProposal)) assert.instanceOf(staleProposal.failure, ApplicationConflict)
      assert.deepStrictEqual(
        yield* inspection.relationshipHistory({ workspaceId: WORKSPACE_ID, relationshipId: RELATIONSHIP_ID }),
        historyAfterApply
      )
    })))

  it.effect("projects plugin facts, redacts secrets, and invalidates only after successful configuration CAS", () =>
    withApplication(Effect.gen(function*() {
      yield* setup
      const invalidations = yield* Ref.make<
        Array<{ readonly pluginConnectionId: PluginConnectionId; readonly workspaceId: WorkspaceId }>
      >([])
      const pluginConnections: PluginConnectionMapV1 = {
        contextEffect: () => Effect.die("configuration patch must not acquire a provider runtime"),
        invalidate: (scope) => Ref.update(invalidations, (scopes) => [...scopes, scope])
      }
      const administration = yield* makePluginAdministrationWithConnections(pluginConnections)
      const listed = yield* administration.list(WORKSPACE_ID)
      assert.lengthOf(listed, 2)
      assert.strictEqual(listed[0]?.health?._tag, "healthy")
      assert.isNull(listed[1]?.health)

      const metadata = yield* administration.configurationMetadata({
        workspaceId: WORKSPACE_ID,
        pluginConnectionId: PLUGIN_ID
      })
      assert.strictEqual(metadata.pluginId, "dev.knpkv.jira")
      assert.deepStrictEqual(metadata.adapterVersion, { major: 2, minor: 1, patch: 0 })

      const empty = yield* administration.configuration({
        workspaceId: WORKSPACE_ID,
        pluginConnectionId: PLUGIN_ID
      })
      assert.deepStrictEqual(empty.values, [{
        _tag: "secret-reference",
        key: PluginConfigurationKey.make("token"),
        state: "missing"
      }])

      const missingKeep = yield* administration.patchConfiguration({
        workspaceId: WORKSPACE_ID,
        pluginConnectionId: PLUGIN_ID,
        patch: {
          expectedRevision: 0,
          values: [
            { _tag: "text", key: PluginConfigurationKey.make("site"), value: "knpkv" },
            { _tag: "select", key: PluginConfigurationKey.make("project"), value: "PAY" },
            {
              _tag: "secret-reference",
              key: PluginConfigurationKey.make("token"),
              operation: { _tag: "keep" }
            }
          ]
        }
      }).pipe(Effect.result)
      assert.isTrue(Result.isFailure(missingKeep))
      if (Result.isFailure(missingKeep)) {
        assert.instanceOf(missingKeep.failure, ApplicationInvalidRequest)
      }
      assert.lengthOf(yield* Ref.get(invalidations), 0)

      const nonexistentReference = OpaqueSecretReference.make(`secret_${"a".repeat(64)}`)
      const missingSecret = yield* administration.patchConfiguration({
        workspaceId: WORKSPACE_ID,
        pluginConnectionId: PLUGIN_ID,
        patch: {
          expectedRevision: 0,
          values: [
            { _tag: "text", key: PluginConfigurationKey.make("site"), value: "knpkv" },
            { _tag: "select", key: PluginConfigurationKey.make("project"), value: "PAY" },
            {
              _tag: "secret-reference",
              key: PluginConfigurationKey.make("token"),
              operation: { _tag: "replace", reference: nonexistentReference }
            }
          ]
        }
      }).pipe(Effect.result)
      assert.isTrue(Result.isFailure(missingSecret))
      if (Result.isFailure(missingSecret)) {
        assert.instanceOf(missingSecret.failure, ApplicationInvalidRequest)
      }
      assert.lengthOf(yield* Ref.get(invalidations), 0)

      const secrets = yield* SecretStore
      const storedSecretReference = yield* secrets.create(new Uint8Array([115, 101, 99, 114, 101, 116]))
      const secretReference = OpaqueSecretReference.make(storedSecretReference)
      const configured = yield* administration.patchConfiguration({
        workspaceId: WORKSPACE_ID,
        pluginConnectionId: PLUGIN_ID,
        patch: {
          expectedRevision: 0,
          values: [
            { _tag: "text", key: PluginConfigurationKey.make("site"), value: "knpkv" },
            { _tag: "select", key: PluginConfigurationKey.make("project"), value: "PAY" },
            {
              _tag: "secret-reference",
              key: PluginConfigurationKey.make("token"),
              operation: { _tag: "replace", reference: secretReference }
            }
          ]
        }
      })
      assert.strictEqual(configured.revision, 1)
      assert.deepStrictEqual(configured.values[2], {
        _tag: "secret-reference",
        key: PluginConfigurationKey.make("token"),
        state: "configured"
      })
      assert.notInclude(JSON.stringify(configured), secretReference)
      assert.deepStrictEqual(yield* Ref.get(invalidations), [{
        workspaceId: WORKSPACE_ID,
        pluginConnectionId: PLUGIN_ID
      }])

      const kept = yield* administration.patchConfiguration({
        workspaceId: WORKSPACE_ID,
        pluginConnectionId: PLUGIN_ID,
        patch: {
          expectedRevision: 1,
          values: [
            { _tag: "text", key: PluginConfigurationKey.make("site"), value: "knpkv-next" },
            { _tag: "select", key: PluginConfigurationKey.make("project"), value: "PAY" },
            {
              _tag: "secret-reference",
              key: PluginConfigurationKey.make("token"),
              operation: { _tag: "keep" }
            }
          ]
        }
      })
      assert.strictEqual(kept.revision, 2)
      assert.deepStrictEqual(kept.values[2], {
        _tag: "secret-reference",
        key: PluginConfigurationKey.make("token"),
        state: "configured"
      })
      assert.notInclude(JSON.stringify(kept), secretReference)
      assert.lengthOf(yield* Ref.get(invalidations), 2)

      const stale = yield* administration.patchConfiguration({
        workspaceId: WORKSPACE_ID,
        pluginConnectionId: PLUGIN_ID,
        patch: { expectedRevision: 0, values: [] }
      }).pipe(Effect.result)
      assert.isTrue(Result.isFailure(stale))
      if (Result.isFailure(stale)) assert.instanceOf(stale.failure, ApplicationInvalidRequest)
      assert.lengthOf(yield* Ref.get(invalidations), 2)

      const requiredSecretClear = yield* administration.patchConfiguration({
        workspaceId: WORKSPACE_ID,
        pluginConnectionId: PLUGIN_ID,
        patch: {
          expectedRevision: 2,
          values: [
            { _tag: "text", key: PluginConfigurationKey.make("site"), value: "knpkv" },
            { _tag: "select", key: PluginConfigurationKey.make("project"), value: "PAY" },
            {
              _tag: "secret-reference",
              key: PluginConfigurationKey.make("token"),
              operation: { _tag: "clear" }
            }
          ]
        }
      }).pipe(Effect.result)
      assert.isTrue(Result.isFailure(requiredSecretClear))
      if (Result.isFailure(requiredSecretClear)) {
        assert.instanceOf(requiredSecretClear.failure, ApplicationInvalidRequest)
      }
      assert.lengthOf(yield* Ref.get(invalidations), 2)

      const conflict = yield* administration.patchConfiguration({
        workspaceId: WORKSPACE_ID,
        pluginConnectionId: PLUGIN_ID,
        patch: {
          expectedRevision: 1,
          values: [
            { _tag: "text", key: PluginConfigurationKey.make("site"), value: "knpkv" },
            { _tag: "select", key: PluginConfigurationKey.make("project"), value: "PAY" },
            {
              _tag: "secret-reference",
              key: PluginConfigurationKey.make("token"),
              operation: { _tag: "keep" }
            }
          ]
        }
      }).pipe(Effect.result)
      assert.isTrue(Result.isFailure(conflict))
      if (Result.isFailure(conflict)) assert.instanceOf(conflict.failure, ApplicationConflict)
      assert.lengthOf(yield* Ref.get(invalidations), 2)

      const draftMetadata = yield* administration.configurationMetadata({
        workspaceId: WORKSPACE_ID,
        pluginConnectionId: UNREADY_PLUGIN_ID
      })
      assert.strictEqual(draftMetadata.pluginId, "dev.knpkv.jira.read")
      assert.isTrue(
        draftMetadata.configurationFields.some((field) => field._tag === "secret-reference" && field.key === "apiToken")
      )

      yield* secrets.remove(storedSecretReference)
      const externallyRemoved = yield* administration.configuration({
        workspaceId: WORKSPACE_ID,
        pluginConnectionId: PLUGIN_ID
      })
      assert.strictEqual(externallyRemoved.values[2]?._tag, "secret-reference")
      assert.strictEqual(
        externallyRemoved.values[2]?._tag === "secret-reference"
          ? externallyRemoved.values[2].state
          : null,
        "missing"
      )
      const keepMissing = yield* administration.patchConfiguration({
        workspaceId: WORKSPACE_ID,
        pluginConnectionId: PLUGIN_ID,
        patch: {
          expectedRevision: 2,
          values: [
            { _tag: "text", key: PluginConfigurationKey.make("site"), value: "knpkv-next" },
            { _tag: "select", key: PluginConfigurationKey.make("project"), value: "PAY" },
            {
              _tag: "secret-reference",
              key: PluginConfigurationKey.make("token"),
              operation: { _tag: "keep" }
            }
          ]
        }
      }).pipe(Effect.result)
      assert.isTrue(Result.isFailure(keepMissing))
      if (Result.isFailure(keepMissing)) {
        assert.instanceOf(keepMissing.failure, ApplicationInvalidRequest)
      }
      assert.lengthOf(yield* Ref.get(invalidations), 2)
    })))

  it.effect("classifies retrieved people as users and AWS principals as accounts", () =>
    withApplication(Effect.gen(function*() {
      yield* setup
      const persistence = yield* Persistence
      yield* persistence.pluginConnections.create(WORKSPACE_ID, {
        pluginConnectionId: CONFLUENCE_PLUGIN_ID,
        providerId: "confluence",
        displayName: PluginConnectionDisplayName.make("Payments Confluence"),
        isEnabled: true,
        createdAt: T0
      })
      yield* persistence.pluginConnections.create(WORKSPACE_ID, {
        pluginConnectionId: CODEPIPELINE_PLUGIN_ID,
        providerId: "codepipeline",
        displayName: PluginConnectionDisplayName.make("Payments CodePipeline"),
        isEnabled: true,
        createdAt: T0
      })
      const connection: PluginConnectionV1 = {
        descriptor: negotiatedDescriptor,
        discover: Effect.succeed({
          account: { providerImmutableId: "atlassian-account-123", displayName: "Avery Bell" },
          workspace: { providerImmutableId: "site-456", displayName: "Payments Jira" },
          endpoints: [],
          discoveredAt: T0
        }),
        health: Effect.succeed({ _tag: "healthy", checkedAt: T0 }),
        sync: () => Stream.die("not used"),
        readEntity: () => Effect.die("not used"),
        diff: Option.none(),
        proposeAction: () => Effect.die("not used")
      }
      const pluginConnections: PluginConnectionMapV1 = {
        contextEffect: ({ pluginConnectionId, workspaceId }) =>
          workspaceId === WORKSPACE_ID &&
            (pluginConnectionId === PLUGIN_ID ||
              pluginConnectionId === CONFLUENCE_PLUGIN_ID ||
              pluginConnectionId === CODEPIPELINE_PLUGIN_ID)
            ? Effect.succeed(Context.make(PluginConnection, connection))
            : Effect.die("connection test crossed its requested scope"),
        invalidate: () => Effect.void
      }
      const administration = yield* makePluginAdministrationWithConnections(pluginConnections)
      const result = yield* administration.testConnection({
        workspaceId: WORKSPACE_ID,
        pluginConnectionId: PLUGIN_ID
      })

      assert.strictEqual(result._tag, "healthy")
      if (result._tag === "healthy") {
        assert.deepStrictEqual(result.identity, {
          kind: "user",
          label: "Atlassian user",
          displayName: "Avery Bell",
          providerImmutableId: "atlassian-account-123"
        })
      }

      const confluenceResult = yield* administration.testConnection({
        workspaceId: WORKSPACE_ID,
        pluginConnectionId: CONFLUENCE_PLUGIN_ID
      })
      assert.strictEqual(confluenceResult._tag, "healthy")
      if (confluenceResult._tag === "healthy") {
        assert.deepStrictEqual(confluenceResult.identity, {
          kind: "user",
          label: "Atlassian user",
          displayName: "Avery Bell",
          providerImmutableId: "atlassian-account-123"
        })
      }

      const codePipelineResult = yield* administration.testConnection({
        workspaceId: WORKSPACE_ID,
        pluginConnectionId: CODEPIPELINE_PLUGIN_ID
      })
      assert.strictEqual(codePipelineResult._tag, "healthy")
      if (codePipelineResult._tag === "healthy") {
        assert.deepStrictEqual(codePipelineResult.identity, {
          kind: "account",
          label: "AWS account",
          displayName: "Avery Bell",
          providerImmutableId: "atlassian-account-123"
        })
      }
    })))

  it.effect("keeps disabled connection tests provider-inert", () =>
    withApplication(Effect.gen(function*() {
      yield* setup
      const acquisitions = yield* Ref.make(0)
      const pluginConnections: PluginConnectionMapV1 = {
        contextEffect: () =>
          Ref.update(acquisitions, (count) => count + 1).pipe(
            Effect.andThen(Effect.die("disabled connection acquired a provider runtime"))
          ),
        invalidate: () => Effect.void
      }
      const administration = yield* makePluginAdministrationWithConnections(pluginConnections)
      const result = yield* administration.testConnection({
        workspaceId: WORKSPACE_ID,
        pluginConnectionId: UNREADY_PLUGIN_ID
      })

      assert.strictEqual(result._tag, "failed")
      assert.strictEqual(result._tag === "failed" ? result.safeMessage : null, "This connection is disabled.")
      assert.strictEqual(yield* Ref.get(acquisitions), 0)
    })))

  it.effect("bounds provider-reported health messages for the API response", () =>
    withApplication(Effect.gen(function*() {
      yield* setup
      const connection: PluginConnectionV1 = {
        descriptor: negotiatedDescriptor,
        discover: Effect.die("discovery must not run after unavailable health"),
        health: Effect.succeed({
          _tag: "unavailable",
          checkedAt: T0,
          failureClass: "outage",
          retryAt: null,
          safeMessage: "x".repeat(201)
        }),
        sync: () => Stream.die("not used"),
        readEntity: () => Effect.die("not used"),
        diff: Option.none(),
        proposeAction: () => Effect.die("not used")
      }
      const pluginConnections: PluginConnectionMapV1 = {
        contextEffect: () => Effect.succeed(Context.make(PluginConnection, connection)),
        invalidate: () => Effect.void
      }
      const administration = yield* makePluginAdministrationWithConnections(pluginConnections)
      const result = yield* administration.testConnection({
        workspaceId: WORKSPACE_ID,
        pluginConnectionId: PLUGIN_ID
      })

      const decoded = Schema.decodeUnknownSync(Schema.toType(PluginConnectionTestResult))(result)
      assert.strictEqual(decoded._tag, "failed")
      assert.strictEqual(decoded._tag === "failed" ? decoded.safeMessage.length : null, 200)
    })))

  it.effect("redacts provider operation details when a connection test fails", () =>
    withApplication(Effect.gen(function*() {
      yield* setup
      const connection: PluginConnectionV1 = {
        descriptor: negotiatedDescriptor,
        discover: Effect.die("discovery must not run after failed health"),
        health: Effect.fail(
          new PluginAuthenticationFailure({
            operation: "Bearer secret-token-never-return"
          })
        ),
        sync: () => Stream.die("not used"),
        readEntity: () => Effect.die("not used"),
        diff: Option.none(),
        proposeAction: () => Effect.die("not used")
      }
      const pluginConnections: PluginConnectionMapV1 = {
        contextEffect: () => Effect.succeed(Context.make(PluginConnection, connection)),
        invalidate: () => Effect.void
      }
      const administration = yield* makePluginAdministrationWithConnections(pluginConnections)
      const result = yield* administration.testConnection({
        workspaceId: WORKSPACE_ID,
        pluginConnectionId: PLUGIN_ID
      })

      assert.strictEqual(result._tag, "failed")
      assert.strictEqual(result._tag === "failed" ? result.failureClass : null, "authentication")
      assert.strictEqual(
        result._tag === "failed" ? result.safeMessage : null,
        "The provider rejected these credentials."
      )
      assert.notInclude(JSON.stringify(result), "secret-token-never-return")
    })))

  it.effect("caps compact collaborators deterministically while preserving the total count", () =>
    withApplication(Effect.gen(function*() {
      const persistence = yield* setup
      const people = Array.from({ length: 51 }, (_, index) => {
        const displayName = `Person ${index.toString().padStart(2, "0")}`
        const personId = Schema.decodeSync(PersonId)(
          `01890f6f-6d6a-7cc0-98d3-${index.toString(16).padStart(12, "0")}`
        )
        return Schema.decodeSync(Person)({
          personId,
          displayName,
          avatar: { _tag: "initials", text: derivePersonInitials(displayName) },
          isActive: true,
          sourceIdentities: []
        })
      })
      for (const person of people) yield* persistence.people.createPerson(WORKSPACE_ID, person, T0)
      const crowdedRelease = Schema.decodeSync(Schema.toType(Release))({
        ...release,
        roleAssignments: people.map((person, index) => ({
          actor: { _tag: "human", personId: person.personId },
          assignmentId: Schema.decodeSync(RoleAssignmentId)(
            `01890f6f-6d6a-7cc0-98d4-${index.toString(16).padStart(12, "0")}`
          ),
          lifecycle: { _tag: "active", assignedAt: T0 },
          role: "release-owner",
          scope: { _tag: "release", releaseId: RELEASE_ID, workspaceId: WORKSPACE_ID }
        }))
      })
      yield* persistence.releases.create(WORKSPACE_ID, crowdedRelease)

      const portfolio = yield* makePortfolioSnapshots
      const snapshot = yield* portfolio.snapshot(WORKSPACE_ID)
      assert.strictEqual(snapshot.releases[0]?.collaboratorCount, 51)
      assert.lengthOf(snapshot.releases[0]?.collaborators ?? [], 50)
      assert.strictEqual(snapshot.releases[0]?.collaborators[0]?.displayName, "Person 00")
      assert.strictEqual(snapshot.releases[0]?.collaborators[49]?.displayName, "Person 49")
    })))

  it.effect("returns a compact factual portfolio without inventing absent readiness or relationships", () =>
    withApplication(Effect.gen(function*() {
      const persistence = yield* setup
      yield* persistence.releases.create(WORKSPACE_ID, release)
      const portfolio = yield* makePortfolioSnapshots
      const snapshot = yield* portfolio.snapshot(WORKSPACE_ID)

      assert.strictEqual(snapshot.workspaceId, WORKSPACE_ID)
      assert.lengthOf(snapshot.releases, 1)
      assert.strictEqual(snapshot.releases[0]?.lifecycle, "candidate")
      assert.strictEqual(snapshot.releases[0]?.freshness._tag, "missing")
      assert.deepStrictEqual(snapshot.releases[0]?.collaborators, [])
      assert.strictEqual(snapshot.releases[0]?.collaboratorCount, 0)
      assert.isNull(snapshot.releases[0]?.readiness)
      assert.deepStrictEqual(snapshot.releases[0]?.relationships, {
        issues: 0,
        pipelineExecutions: 0,
        pullRequests: 0,
        truncated: false
      })
      assert.strictEqual(snapshot.releases[0]?.sourceRevisionCount, 0)
      assert.lengthOf(snapshot.plugins, 2)
    })))

  it.effect("ages current release freshness at snapshot time without appending a release revision", () =>
    withApplication(Effect.gen(function*() {
      const persistence = yield* setup
      yield* persistence.releases.create(WORKSPACE_ID, currentRelease)
      yield* TestClock.setTime(epochMillis(SNAPSHOT_AT))

      const portfolio = yield* makePortfolioSnapshots
      const snapshot = yield* portfolio.snapshot(WORKSPACE_ID)
      const persisted = yield* persistence.releases.get(WORKSPACE_ID, RELEASE_ID)

      assert.isTrue(DateTime.Equivalence(snapshot.generatedAt, SNAPSHOT_AT))
      const projectedFreshness = snapshot.releases[0]?.freshness
      if (projectedFreshness?._tag !== "stale") return yield* Effect.die("expected stale projection")
      const evaluatedAt = projectedFreshness.evaluatedAt
      assert.isDefined(evaluatedAt)
      if (evaluatedAt !== undefined) assert.isTrue(DateTime.Equivalence(evaluatedAt, SNAPSHOT_AT))
      assert.strictEqual(persisted.revision, 1)
      assert.strictEqual(persisted.release.freshness._tag, "current")
      if (persisted.release.freshness._tag === "current") {
        assert.isUndefined(persisted.release.freshness.evaluatedAt)
      }
    })))

  it.effect("resolves only workspace-owned, bounded safe raster media", () =>
    withApplication(Effect.gen(function*() {
      const persistence = yield* setup
      const media = yield* makeMediaReads
      const png = yield* persistence.content.put(WORKSPACE_ID, {
        bytes: new Uint8Array([137, 80, 78, 71]),
        classification: "reproducible-cache",
        mimeType: "image/png",
        createdAt: T0
      })
      const mediaId = OpaqueMediaId.make(`media_${png.metadata.digest}`)
      assert.instanceOf(
        mapPersistenceReadError(new BlobNotFoundError({ digest: png.metadata.digest })),
        ApplicationServiceUnavailable
      )
      const opened = yield* media.read({ workspaceId: WORKSPACE_ID, mediaId })
      assert.strictEqual(opened.contentType, "image/png")
      const chunks = yield* Stream.runCollect(opened.body)
      assert.deepStrictEqual(
        Array.from(chunks[0] ?? []),
        [137, 80, 78, 71]
      )

      const crossWorkspace = yield* media.read({ workspaceId: OTHER_WORKSPACE_ID, mediaId }).pipe(Effect.result)
      assert.isTrue(Result.isFailure(crossWorkspace))
      if (Result.isFailure(crossWorkspace)) {
        assert.instanceOf(crossWorkspace.failure, ApplicationResourceNotFound)
      }

      const text = yield* persistence.content.put(WORKSPACE_ID, {
        bytes: new Uint8Array([60, 115, 118, 103, 62]),
        classification: "reproducible-cache",
        mimeType: "image/svg+xml",
        createdAt: T0
      })
      const unsafeMediaId = OpaqueMediaId.make(`media_${text.metadata.digest}`)
      const unsafe = yield* media.read({ workspaceId: WORKSPACE_ID, mediaId: unsafeMediaId }).pipe(Effect.result)
      assert.isTrue(Result.isFailure(unsafe))
      if (Result.isFailure(unsafe)) assert.instanceOf(unsafe.failure, ApplicationResourceNotFound)

      const oversized = yield* persistence.content.put(WORKSPACE_ID, {
        bytes: new Uint8Array((8 * 1024 * 1024) + 1),
        classification: "reproducible-cache",
        mimeType: "image/png",
        createdAt: T0
      })
      const oversizedMediaId = OpaqueMediaId.make(`media_${oversized.metadata.digest}`)
      const rejectedSize = yield* media.read({
        workspaceId: WORKSPACE_ID,
        mediaId: oversizedMediaId
      }).pipe(Effect.result)
      assert.isTrue(Result.isFailure(rejectedSize))
      if (Result.isFailure(rejectedSize)) {
        assert.instanceOf(rejectedSize.failure, ApplicationResourceNotFound)
      }
    })))
})
