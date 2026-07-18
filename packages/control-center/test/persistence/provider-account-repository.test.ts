import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert, describe, it } from "@effect/vitest"
import { Effect, FileSystem, Layer, Result, Schema } from "effect"

import { FollowedResourceId, ProviderAccountId, WorkspaceId } from "../../src/domain/identifiers.js"
import { UtcTimestamp } from "../../src/domain/utcTimestamp.js"
import type { Database } from "../../src/server/persistence/Database.js"
import { databaseLayer } from "../../src/server/persistence/Database.js"
import { RecordAlreadyExistsError, RevisionConflictError } from "../../src/server/persistence/errors.js"
import {
  FollowedResourceDisplayName,
  ProviderAccountDisplayName,
  RecordRevision,
  VendorAccountId,
  VendorResourceId,
  WorkspaceName
} from "../../src/server/persistence/repositories/models.js"
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
    Database | ProviderAccountRepository | QuarantineRepository | WorkspaceRepository
  >
) =>
  Effect.gen(function*() {
    const config = yield* testConfig
    const database = databaseLayer(config)
    const foundation = QuarantineRepository.layer.pipe(Layer.provideMerge(database))
    const accounts = ProviderAccountRepository.layer.pipe(Layer.provide(foundation))
    const workspaces = WorkspaceRepository.layer.pipe(Layer.provide(foundation))
    return yield* use.pipe(Effect.provide(Layer.mergeAll(foundation, accounts, workspaces)))
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
})
