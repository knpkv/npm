import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Result, Schema, Stream } from "effect"
import * as DateTime from "effect/DateTime"
import * as TestClock from "effect/testing/TestClock"

import { OpaqueMediaId, OpaqueSecretReference, PluginConfigurationKey } from "../../src/api/index.js"
import { derivePersonInitials, Person } from "../../src/domain/actors.js"
import { LedgerRevision } from "../../src/domain/deliveryGraph.js"
import {
  EnvironmentId,
  PersonId,
  PluginConnectionId,
  RelationshipId,
  ReleaseId,
  RoleAssignmentId,
  WorkspaceId
} from "../../src/domain/identifiers.js"
import { Release } from "../../src/domain/release.js"
import { deriveReleaseRelay } from "../../src/domain/releaseRelay.js"
import { UtcTimestamp } from "../../src/domain/utcTimestamp.js"
import {
  ApplicationConflict,
  ApplicationInvalidRequest,
  ApplicationResourceNotFound,
  ApplicationServiceUnavailable
} from "../../src/server/api/ApplicationServices.js"
import {
  makeDeliveryGraphInspection,
  makeMediaReads,
  makePluginAdministration,
  makePortfolioSnapshots,
  mapPersistenceReadError
} from "../../src/server/application/index.js"
import { BlobNotFoundError } from "../../src/server/persistence/object-store/BlobStoreError.js"
import { Persistence, persistenceLayer } from "../../src/server/persistence/Persistence.js"
import { PluginConnectionDisplayName, WorkspaceName } from "../../src/server/persistence/repositories/models.js"
import { SecretRoot, SecretStore } from "../../src/server/secrets/SecretStore.js"
import { makePersistenceTestConfig } from "../persistence/fixtures.js"

const WORKSPACE_ID = Schema.decodeSync(WorkspaceId)("01890f6f-6d6a-7cc0-98d2-000000000071")
const OTHER_WORKSPACE_ID = Schema.decodeSync(WorkspaceId)("01890f6f-6d6a-7cc0-98d2-000000000072")
const PLUGIN_ID = Schema.decodeSync(PluginConnectionId)("01890f6f-6d6a-7cc0-98d2-000000000073")
const UNREADY_PLUGIN_ID = Schema.decodeSync(PluginConnectionId)("01890f6f-6d6a-7cc0-98d2-000000000074")
const RELEASE_ID = Schema.decodeSync(ReleaseId)("01890f6f-6d6a-7cc0-98d2-000000000075")
const ENVIRONMENT_ID = Schema.decodeSync(EnvironmentId)("01890f6f-6d6a-7cc0-98d2-000000000076")
const RELATIONSHIP_ID = Schema.decodeSync(RelationshipId)("01890f6f-6d6a-7cc0-98d2-000000000077")
const OTHER_RELEASE_ID = Schema.decodeSync(ReleaseId)("01890f6f-6d6a-7cc0-98d2-000000000078")
const RELATIONSHIP_REVISION = Schema.decodeSync(LedgerRevision)(1)
const T0 = Schema.decodeSync(UtcTimestamp)("2026-07-14T10:00:00.000Z")
const SNAPSHOT_AT = Schema.decodeSync(UtcTimestamp)("2026-07-14T10:10:00.000Z")

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
  use: Effect.Effect<Success, Failure, Persistence | SecretStore>
) =>
  Effect.gen(function*() {
    const config = yield* makePersistenceTestConfig("control-center-application-")
    const secretRoot = SecretRoot.make(`${config.blobRoot.slice(0, -"/blobs".length)}/secrets`)
    const applicationDependencies = Layer.merge(
      persistenceLayer(config),
      SecretStore.layer({ secretRoot })
    )
    return yield* use.pipe(Effect.provide(applicationDependencies))
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped)

const setup = Effect.gen(function*() {
  const persistence = yield* Persistence
  yield* persistence.workspaces.create(WORKSPACE_ID, {
    displayName: WorkspaceName.make("Payments"),
    createdAt: T0
  })
  yield* persistence.workspaces.create(OTHER_WORKSPACE_ID, {
    displayName: WorkspaceName.make("Other"),
    createdAt: T0
  })
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
          }
        ],
        evidenceItems: [],
        evidenceClaims: [],
        relationships: [firstRevision]
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
        relationships: [{
          ...firstRevision,
          revision: 2,
          supersedesRevision: 1,
          lifecycle: { _tag: "proposed", effectiveAt: "2026-07-14T10:01:00.000Z" },
          recordedAt: "2026-07-14T10:01:00.000Z"
        }]
      })
      const historyBefore = yield* inspection.relationshipHistory({
        workspaceId: WORKSPACE_ID,
        relationshipId: RELATIONSHIP_ID
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
      assert.deepStrictEqual(
        yield* inspection.relationshipHistory({ workspaceId: WORKSPACE_ID, relationshipId: RELATIONSHIP_ID }),
        historyBefore
      )
    })))

  it.effect("projects plugin facts, validates descriptor fields, redacts secrets, and preserves CAS", () =>
    withApplication(Effect.gen(function*() {
      yield* setup
      const administration = yield* makePluginAdministration
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

      const stale = yield* administration.patchConfiguration({
        workspaceId: WORKSPACE_ID,
        pluginConnectionId: PLUGIN_ID,
        patch: { expectedRevision: 0, values: [] }
      }).pipe(Effect.result)
      assert.isTrue(Result.isFailure(stale))
      if (Result.isFailure(stale)) assert.instanceOf(stale.failure, ApplicationInvalidRequest)

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

      const unavailable = yield* administration.configurationMetadata({
        workspaceId: WORKSPACE_ID,
        pluginConnectionId: UNREADY_PLUGIN_ID
      }).pipe(Effect.result)
      assert.isTrue(Result.isFailure(unavailable))
      if (Result.isFailure(unavailable)) assert.instanceOf(unavailable.failure, ApplicationServiceUnavailable)

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

  it.effect("returns a compact factual portfolio without deriving readiness", () =>
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
