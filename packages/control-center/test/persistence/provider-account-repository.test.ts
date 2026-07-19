import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert, describe, it } from "@effect/vitest"
import { Effect, FileSystem, Layer, Result, Schema } from "effect"

import { FollowedResourceId, PluginConnectionId, ProviderAccountId, WorkspaceId } from "../../src/domain/identifiers.js"
import { UtcTimestamp } from "../../src/domain/utcTimestamp.js"
import { Database, databaseLayer } from "../../src/server/persistence/Database.js"
import {
  PersistenceOperationError,
  RecordAlreadyExistsError,
  RevisionConflictError
} from "../../src/server/persistence/errors.js"
import {
  FollowedResourceDisplayName,
  PluginConnectionDisplayName,
  ProviderAccountDisplayName,
  RecordRevision,
  VendorAccountId,
  VendorResourceId,
  WorkspaceName
} from "../../src/server/persistence/repositories/models.js"
import { PluginConnectionRepository } from "../../src/server/persistence/repositories/pluginConnectionRepository.js"
import {
  ProviderAccountInputError,
  ProviderAccountRepository
} from "../../src/server/persistence/repositories/providerAccountRepository.js"
import { QuarantineRepository } from "../../src/server/persistence/repositories/quarantineRepository.js"
import { WorkspaceRepository } from "../../src/server/persistence/repositories/workspaceRepository.js"

const WORKSPACE_A = Schema.decodeSync(WorkspaceId)("01890f6f-6d6a-7cc0-98d2-000000000001")
const WORKSPACE_B = Schema.decodeSync(WorkspaceId)("01890f6f-6d6a-7cc0-98d2-000000000002")
const AWS_ACCOUNT_ID = Schema.decodeSync(ProviderAccountId)("01890f6f-6d6a-7cc0-98d2-000000000003")
const SECOND_ACCOUNT_ID = Schema.decodeSync(ProviderAccountId)("01890f6f-6d6a-7cc0-98d2-000000000004")
const REPOSITORY_ID = Schema.decodeSync(FollowedResourceId)("01890f6f-6d6a-7cc0-98d2-000000000005")
const PIPELINE_ID = Schema.decodeSync(FollowedResourceId)("01890f6f-6d6a-7cc0-98d2-000000000006")
const JIRA_ID = Schema.decodeSync(FollowedResourceId)("01890f6f-6d6a-7cc0-98d2-000000000007")
const SECOND_REPOSITORY_ID = Schema.decodeSync(FollowedResourceId)("01890f6f-6d6a-7cc0-98d2-00000000000b")
const ATLASSIAN_ACCOUNT_ID = Schema.decodeSync(ProviderAccountId)("01890f6f-6d6a-7cc0-98d2-00000000000c")
const CONFLUENCE_ID = Schema.decodeSync(FollowedResourceId)("01890f6f-6d6a-7cc0-98d2-00000000000d")
const DUPLICATE_JIRA_ID = Schema.decodeSync(FollowedResourceId)("01890f6f-6d6a-7cc0-98d2-00000000000e")
const DUPLICATE_CONFLUENCE_ID = Schema.decodeSync(FollowedResourceId)("01890f6f-6d6a-7cc0-98d2-00000000000f")
const REPOSITORY_CONNECTION_ID = Schema.decodeSync(PluginConnectionId)(
  "01890f6f-6d6a-7cc0-98d2-000000000008"
)
const PIPELINE_CONNECTION_ID = Schema.decodeSync(PluginConnectionId)(
  "01890f6f-6d6a-7cc0-98d2-000000000009"
)
const SECOND_REPOSITORY_CONNECTION_ID = Schema.decodeSync(PluginConnectionId)(
  "01890f6f-6d6a-7cc0-98d2-00000000000a"
)
const CREATED_AT = Schema.decodeSync(UtcTimestamp)("2026-07-18T10:00:00.000Z")
const UPDATED_AT = Schema.decodeSync(UtcTimestamp)("2026-07-18T11:00:00.000Z")

const testConfig = Effect.gen(function*() {
  const fileSystem = yield* FileSystem.FileSystem
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "control-center-provider-account-" })
  return {
    blobRoot: `${root}/blobs`,
    busyTimeoutMilliseconds: 5_000,
    databaseUrl: `file:${root}/control-center.db`,
    maxConnections: 1
  }
})

const withRepositories = <Success, Failure>(
  use: Effect.Effect<
    Success,
    Failure,
    | Database
    | PluginConnectionRepository
    | ProviderAccountRepository
    | QuarantineRepository
    | WorkspaceRepository
  >
) =>
  Effect.gen(function*() {
    const config = yield* testConfig
    const database = databaseLayer(config)
    const foundation = QuarantineRepository.layer.pipe(Layer.provideMerge(database))
    const accounts = ProviderAccountRepository.layer.pipe(Layer.provide(foundation))
    const connections = PluginConnectionRepository.layer.pipe(Layer.provide(foundation))
    const workspaces = WorkspaceRepository.layer.pipe(Layer.provide(foundation))
    return yield* use.pipe(Effect.provide(Layer.mergeAll(foundation, accounts, connections, workspaces)))
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped)

const createWorkspace = Effect.gen(function*() {
  const workspaces = yield* WorkspaceRepository
  yield* workspaces.create(WORKSPACE_A, {
    displayName: WorkspaceName.make("Payments"),
    createdAt: CREATED_AT
  })
})

const createAwsAccount = Effect.gen(function*() {
  const accounts = yield* ProviderAccountRepository
  return yield* accounts.create(WORKSPACE_A, {
    providerAccountId: AWS_ACCOUNT_ID,
    providerFamily: "aws",
    vendorAccountId: VendorAccountId.make("123456789012"),
    displayName: ProviderAccountDisplayName.make("Production AWS"),
    createdAt: CREATED_AT
  })
})

describe("provider account repository", () => {
  it.effect("stores one AWS account with multiple repositories and pipelines", () =>
    withRepositories(
      Effect.gen(function*() {
        yield* createWorkspace
        const accounts = yield* ProviderAccountRepository
        const connections = yield* PluginConnectionRepository
        const account = yield* createAwsAccount

        assert.strictEqual(account.vendorAccountId, "123456789012")
        yield* accounts.followResource(WORKSPACE_A, {
          followedResourceId: REPOSITORY_ID,
          providerAccountId: AWS_ACCOUNT_ID,
          providerId: "codecommit",
          vendorResourceId: VendorResourceId.make("payments-api"),
          displayName: FollowedResourceDisplayName.make("Payments API"),
          isEnabled: true,
          createdAt: CREATED_AT
        })
        yield* accounts.followResource(WORKSPACE_A, {
          followedResourceId: PIPELINE_ID,
          providerAccountId: AWS_ACCOUNT_ID,
          providerId: "codepipeline",
          vendorResourceId: VendorResourceId.make("payments-release"),
          displayName: FollowedResourceDisplayName.make("Payments release"),
          isEnabled: true,
          createdAt: CREATED_AT
        })

        const repositoryConnection = yield* connections.create(WORKSPACE_A, {
          pluginConnectionId: REPOSITORY_CONNECTION_ID,
          providerId: "codecommit",
          displayName: PluginConnectionDisplayName.make("Payments API"),
          isEnabled: true,
          createdAt: CREATED_AT
        })
        const pipelineConnection = yield* connections.create(WORKSPACE_A, {
          pluginConnectionId: PIPELINE_CONNECTION_ID,
          providerId: "codepipeline",
          displayName: PluginConnectionDisplayName.make("Payments release"),
          isEnabled: true,
          createdAt: CREATED_AT
        })
        assert.isNull(repositoryConnection.providerAccountId)
        assert.isNull(repositoryConnection.followedResourceId)
        assert.isNull(pipelineConnection.providerAccountId)
        assert.isNull(pipelineConnection.followedResourceId)

        const boundRepository = yield* connections.bindResource(WORKSPACE_A, REPOSITORY_CONNECTION_ID, {
          providerAccountId: AWS_ACCOUNT_ID,
          followedResourceId: REPOSITORY_ID,
          expectedRevision: RecordRevision.make(1),
          updatedAt: UPDATED_AT
        })
        const boundPipeline = yield* connections.bindResource(WORKSPACE_A, PIPELINE_CONNECTION_ID, {
          providerAccountId: AWS_ACCOUNT_ID,
          followedResourceId: PIPELINE_ID,
          expectedRevision: RecordRevision.make(1),
          updatedAt: UPDATED_AT
        })
        assert.strictEqual(boundRepository.providerAccountId, AWS_ACCOUNT_ID)
        assert.strictEqual(boundRepository.followedResourceId, REPOSITORY_ID)
        assert.strictEqual(boundRepository.revision, 2)
        assert.strictEqual(boundPipeline.providerAccountId, AWS_ACCOUNT_ID)
        assert.strictEqual(boundPipeline.followedResourceId, PIPELINE_ID)
        const resources = yield* accounts.listResources(WORKSPACE_A, AWS_ACCOUNT_ID)
        assert.deepStrictEqual(resources.map(({ providerId }) => providerId), ["codecommit", "codepipeline"])
        assert.isTrue(resources.every(({ providerAccountId }) => providerAccountId === AWS_ACCOUNT_ID))

        const updated = yield* accounts.updateResourceMetadata(WORKSPACE_A, REPOSITORY_ID, {
          displayName: FollowedResourceDisplayName.make("Payments API archived"),
          isEnabled: false,
          expectedRevision: RecordRevision.make(1),
          updatedAt: UPDATED_AT
        })
        assert.strictEqual(updated.revision, 2)
        assert.isFalse(updated.isEnabled)
      })
    ))

  it.effect("service-scopes Atlassian resource identity while rejecting same-service duplicates", () =>
    withRepositories(
      Effect.gen(function*() {
        yield* createWorkspace
        const accounts = yield* ProviderAccountRepository
        yield* accounts.create(WORKSPACE_A, {
          providerAccountId: ATLASSIAN_ACCOUNT_ID,
          providerFamily: "atlassian",
          vendorAccountId: VendorAccountId.make("cloud-acme"),
          displayName: ProviderAccountDisplayName.make("acme.atlassian.net"),
          createdAt: CREATED_AT
        })
        yield* accounts.followResource(WORKSPACE_A, {
          followedResourceId: JIRA_ID,
          providerAccountId: ATLASSIAN_ACCOUNT_ID,
          providerId: "jira",
          vendorResourceId: VendorResourceId.make("shared-resource"),
          displayName: FollowedResourceDisplayName.make("Jira"),
          isEnabled: true,
          createdAt: CREATED_AT
        })
        yield* accounts.followResource(WORKSPACE_A, {
          followedResourceId: CONFLUENCE_ID,
          providerAccountId: ATLASSIAN_ACCOUNT_ID,
          providerId: "confluence",
          vendorResourceId: VendorResourceId.make("shared-resource"),
          displayName: FollowedResourceDisplayName.make("Space · shared-resource"),
          isEnabled: true,
          createdAt: CREATED_AT
        })

        const duplicateJira = yield* accounts.followResource(WORKSPACE_A, {
          followedResourceId: DUPLICATE_JIRA_ID,
          providerAccountId: ATLASSIAN_ACCOUNT_ID,
          providerId: "jira",
          vendorResourceId: VendorResourceId.make("shared-resource"),
          displayName: FollowedResourceDisplayName.make("Duplicate Jira"),
          isEnabled: true,
          createdAt: CREATED_AT
        }).pipe(Effect.result)
        const duplicateConfluence = yield* accounts.followResource(WORKSPACE_A, {
          followedResourceId: DUPLICATE_CONFLUENCE_ID,
          providerAccountId: ATLASSIAN_ACCOUNT_ID,
          providerId: "confluence",
          vendorResourceId: VendorResourceId.make("shared-resource"),
          displayName: FollowedResourceDisplayName.make("Duplicate space"),
          isEnabled: true,
          createdAt: CREATED_AT
        }).pipe(Effect.result)

        assert.isTrue(Result.isFailure(duplicateJira))
        if (Result.isFailure(duplicateJira)) assert.instanceOf(duplicateJira.failure, PersistenceOperationError)
        assert.isTrue(Result.isFailure(duplicateConfluence))
        if (Result.isFailure(duplicateConfluence)) {
          assert.instanceOf(duplicateConfluence.failure, PersistenceOperationError)
        }
        assert.deepStrictEqual(
          (yield* accounts.listResources(WORKSPACE_A, ATLASSIAN_ACCOUNT_ID))
            .map(({ followedResourceId, providerId }) => ({ followedResourceId, providerId })),
          [
            { followedResourceId: CONFLUENCE_ID, providerId: "confluence" },
            { followedResourceId: JIRA_ID, providerId: "jira" }
          ]
        )
      })
    ))

  it.effect("rejects a service mismatch and a second connection for the same resource", () =>
    withRepositories(
      Effect.gen(function*() {
        yield* createWorkspace
        yield* createAwsAccount
        const accounts = yield* ProviderAccountRepository
        const connections = yield* PluginConnectionRepository
        yield* accounts.followResource(WORKSPACE_A, {
          followedResourceId: REPOSITORY_ID,
          providerAccountId: AWS_ACCOUNT_ID,
          providerId: "codecommit",
          vendorResourceId: VendorResourceId.make("payments-api"),
          displayName: FollowedResourceDisplayName.make("Payments API"),
          isEnabled: true,
          createdAt: CREATED_AT
        })
        yield* connections.create(WORKSPACE_A, {
          pluginConnectionId: PIPELINE_CONNECTION_ID,
          providerId: "codepipeline",
          displayName: PluginConnectionDisplayName.make("Wrong service"),
          isEnabled: true,
          createdAt: CREATED_AT
        })
        const mismatch = yield* connections.bindResource(WORKSPACE_A, PIPELINE_CONNECTION_ID, {
          providerAccountId: AWS_ACCOUNT_ID,
          followedResourceId: REPOSITORY_ID,
          expectedRevision: RecordRevision.make(1),
          updatedAt: UPDATED_AT
        }).pipe(Effect.result)
        assert.isTrue(Result.isFailure(mismatch))
        if (Result.isFailure(mismatch)) assert.instanceOf(mismatch.failure, PersistenceOperationError)

        yield* connections.create(WORKSPACE_A, {
          pluginConnectionId: REPOSITORY_CONNECTION_ID,
          providerId: "codecommit",
          displayName: PluginConnectionDisplayName.make("Primary repository"),
          isEnabled: true,
          createdAt: CREATED_AT
        })
        yield* connections.bindResource(WORKSPACE_A, REPOSITORY_CONNECTION_ID, {
          providerAccountId: AWS_ACCOUNT_ID,
          followedResourceId: REPOSITORY_ID,
          expectedRevision: RecordRevision.make(1),
          updatedAt: UPDATED_AT
        })
        yield* accounts.followResource(WORKSPACE_A, {
          followedResourceId: SECOND_REPOSITORY_ID,
          providerAccountId: AWS_ACCOUNT_ID,
          providerId: "codecommit",
          vendorResourceId: VendorResourceId.make("risk-engine"),
          displayName: FollowedResourceDisplayName.make("Risk engine"),
          isEnabled: true,
          createdAt: CREATED_AT
        })
        const rebound = yield* connections.bindResource(WORKSPACE_A, REPOSITORY_CONNECTION_ID, {
          providerAccountId: AWS_ACCOUNT_ID,
          followedResourceId: SECOND_REPOSITORY_ID,
          expectedRevision: RecordRevision.make(2),
          updatedAt: UPDATED_AT
        }).pipe(Effect.result)
        assert.isTrue(Result.isFailure(rebound))
        if (Result.isFailure(rebound)) assert.instanceOf(rebound.failure, RevisionConflictError)
        const stillBound = yield* connections.get(WORKSPACE_A, REPOSITORY_CONNECTION_ID)
        assert.strictEqual(stillBound.followedResourceId, REPOSITORY_ID)
        assert.strictEqual(stillBound.revision, 2)
        yield* connections.create(WORKSPACE_A, {
          pluginConnectionId: SECOND_REPOSITORY_CONNECTION_ID,
          providerId: "codecommit",
          displayName: PluginConnectionDisplayName.make("Duplicate repository"),
          isEnabled: true,
          createdAt: CREATED_AT
        })
        const duplicate = yield* connections.bindResource(WORKSPACE_A, SECOND_REPOSITORY_CONNECTION_ID, {
          providerAccountId: AWS_ACCOUNT_ID,
          followedResourceId: REPOSITORY_ID,
          expectedRevision: RecordRevision.make(1),
          updatedAt: UPDATED_AT
        }).pipe(Effect.result)
        assert.isTrue(Result.isFailure(duplicate))
        if (Result.isFailure(duplicate)) assert.instanceOf(duplicate.failure, PersistenceOperationError)
      })
    ))

  it.effect("rejects provider-family mismatches before writing a resource", () =>
    withRepositories(
      Effect.gen(function*() {
        yield* createWorkspace
        yield* createAwsAccount
        const accounts = yield* ProviderAccountRepository

        const result = yield* accounts.followResource(WORKSPACE_A, {
          followedResourceId: JIRA_ID,
          providerAccountId: AWS_ACCOUNT_ID,
          providerId: "jira",
          vendorResourceId: VendorResourceId.make("cloud-123"),
          displayName: FollowedResourceDisplayName.make("Payments Jira"),
          isEnabled: true,
          createdAt: CREATED_AT
        }).pipe(Effect.result)

        assert.isTrue(Result.isFailure(result))
        if (Result.isFailure(result)) assert.instanceOf(result.failure, ProviderAccountInputError)
        assert.lengthOf(yield* accounts.listResources(WORKSPACE_A, AWS_ACCOUNT_ID), 0)
      })
    ))

  it.effect("isolates accounts by workspace and protects immutable identities and CAS updates", () =>
    withRepositories(
      Effect.gen(function*() {
        const workspaces = yield* WorkspaceRepository
        const accounts = yield* ProviderAccountRepository
        yield* createWorkspace
        yield* workspaces.create(WORKSPACE_B, {
          displayName: WorkspaceName.make("Identity"),
          createdAt: CREATED_AT
        })
        yield* createAwsAccount
        yield* accounts.create(WORKSPACE_B, {
          providerAccountId: SECOND_ACCOUNT_ID,
          providerFamily: "aws",
          vendorAccountId: VendorAccountId.make("123456789012"),
          displayName: ProviderAccountDisplayName.make("Identity AWS"),
          createdAt: CREATED_AT
        })

        assert.lengthOf(yield* accounts.list(WORKSPACE_A), 1)
        assert.lengthOf(yield* accounts.list(WORKSPACE_B), 1)

        const duplicate = yield* accounts.create(WORKSPACE_A, {
          providerAccountId: SECOND_ACCOUNT_ID,
          providerFamily: "aws",
          vendorAccountId: VendorAccountId.make("123456789012"),
          displayName: ProviderAccountDisplayName.make("Duplicate AWS"),
          createdAt: CREATED_AT
        }).pipe(Effect.result)
        assert.isTrue(Result.isFailure(duplicate))
        if (Result.isFailure(duplicate)) assert.instanceOf(duplicate.failure, RecordAlreadyExistsError)

        yield* accounts.updateMetadata(WORKSPACE_A, AWS_ACCOUNT_ID, {
          displayName: ProviderAccountDisplayName.make("Primary AWS"),
          expectedRevision: RecordRevision.make(1),
          updatedAt: UPDATED_AT
        })
        const stale = yield* accounts.updateMetadata(WORKSPACE_A, AWS_ACCOUNT_ID, {
          displayName: ProviderAccountDisplayName.make("Stale AWS"),
          expectedRevision: RecordRevision.make(1),
          updatedAt: UPDATED_AT
        }).pipe(Effect.result)
        assert.isTrue(Result.isFailure(stale))
        if (Result.isFailure(stale)) assert.instanceOf(stale.failure, RevisionConflictError)
      })
    ))

  it.effect("quarantines malformed list rows while returning healthy accounts and resources", () =>
    withRepositories(
      Effect.gen(function*() {
        yield* createWorkspace
        yield* createAwsAccount
        const accounts = yield* ProviderAccountRepository
        const database = yield* Database
        const quarantine = yield* QuarantineRepository

        yield* accounts.create(WORKSPACE_A, {
          providerAccountId: SECOND_ACCOUNT_ID,
          providerFamily: "aws",
          vendorAccountId: VendorAccountId.make("210987654321"),
          displayName: ProviderAccountDisplayName.make("Sandbox AWS"),
          createdAt: CREATED_AT
        })
        yield* accounts.followResource(WORKSPACE_A, {
          followedResourceId: REPOSITORY_ID,
          providerAccountId: AWS_ACCOUNT_ID,
          providerId: "codecommit",
          vendorResourceId: VendorResourceId.make("payments-api"),
          displayName: FollowedResourceDisplayName.make("Payments API"),
          isEnabled: true,
          createdAt: CREATED_AT
        })
        yield* accounts.followResource(WORKSPACE_A, {
          followedResourceId: PIPELINE_ID,
          providerAccountId: AWS_ACCOUNT_ID,
          providerId: "codepipeline",
          vendorResourceId: VendorResourceId.make("payments-release"),
          displayName: FollowedResourceDisplayName.make("Payments release"),
          isEnabled: true,
          createdAt: CREATED_AT
        })

        yield* database.sql`PRAGMA ignore_check_constraints = ON`
        yield* database.sql`UPDATE provider_accounts
          SET display_name = ''
          WHERE workspace_id = ${WORKSPACE_A}
            AND provider_account_id = ${SECOND_ACCOUNT_ID}`
        yield* database.sql`UPDATE followed_resources
          SET display_name = ''
          WHERE workspace_id = ${WORKSPACE_A}
            AND followed_resource_id = ${PIPELINE_ID}`
        yield* database.sql`PRAGMA ignore_check_constraints = OFF`

        const listedAccounts = yield* accounts.list(WORKSPACE_A)
        const listedResources = yield* accounts.listResources(WORKSPACE_A, AWS_ACCOUNT_ID)
        const quarantined = yield* quarantine.list(WORKSPACE_A)

        assert.deepStrictEqual(listedAccounts.map(({ providerAccountId }) => providerAccountId), [AWS_ACCOUNT_ID])
        assert.deepStrictEqual(listedResources.map(({ followedResourceId }) => followedResourceId), [REPOSITORY_ID])
        assert.sameMembers(
          quarantined.map(({ recordKey }) => recordKey),
          [SECOND_ACCOUNT_ID, PIPELINE_ID]
        )

        yield* database.sql`UPDATE provider_accounts
          SET provider_account_id = 'not-a-uuid'
          WHERE workspace_id = ${WORKSPACE_A}
            AND provider_account_id = ${SECOND_ACCOUNT_ID}`
        yield* database.sql`UPDATE followed_resources
          SET followed_resource_id = 'not-a-uuid'
          WHERE workspace_id = ${WORKSPACE_A}
            AND followed_resource_id = ${PIPELINE_ID}`

        assert.deepStrictEqual(
          (yield* accounts.list(WORKSPACE_A)).map(({ providerAccountId }) => providerAccountId),
          [AWS_ACCOUNT_ID]
        )
        assert.deepStrictEqual(
          (yield* accounts.listResources(WORKSPACE_A, AWS_ACCOUNT_ID)).map(
            ({ followedResourceId }) => followedResourceId
          ),
          [REPOSITORY_ID]
        )
        assert.isAtLeast(
          (yield* quarantine.list(WORKSPACE_A)).filter(({ recordKey }) => recordKey === WORKSPACE_A).length,
          2
        )
      })
    ))

  it.effect("quarantines followed resources whose service does not belong to their provider family", () =>
    withRepositories(
      Effect.gen(function*() {
        yield* createWorkspace
        yield* createAwsAccount
        const accounts = yield* ProviderAccountRepository
        const database = yield* Database
        const quarantine = yield* QuarantineRepository
        yield* accounts.followResource(WORKSPACE_A, {
          followedResourceId: REPOSITORY_ID,
          providerAccountId: AWS_ACCOUNT_ID,
          providerId: "codecommit",
          vendorResourceId: VendorResourceId.make("payments-api"),
          displayName: FollowedResourceDisplayName.make("Payments API"),
          isEnabled: true,
          createdAt: CREATED_AT
        })

        yield* database.sql`PRAGMA ignore_check_constraints = ON`
        yield* database.sql`UPDATE followed_resources
          SET provider_id = 'jira'
          WHERE workspace_id = ${WORKSPACE_A}
            AND followed_resource_id = ${REPOSITORY_ID}`
        yield* database.sql`PRAGMA ignore_check_constraints = OFF`

        assert.isEmpty(yield* accounts.listResources(WORKSPACE_A, AWS_ACCOUNT_ID))
        const quarantined = yield* quarantine.list(WORKSPACE_A)
        assert.lengthOf(quarantined, 1)
        assert.strictEqual(quarantined[0]?.recordKey, REPOSITORY_ID)
      })
    ))
})
