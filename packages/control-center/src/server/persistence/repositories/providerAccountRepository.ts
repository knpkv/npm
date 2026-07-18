import {
  renderCreateFollowedResourceQuery,
  renderCreateProviderAccountQuery,
  type RenderedSql,
  renderFollowedResourceQuery,
  renderFollowedResourcesQuery,
  renderProviderAccountIdentityQuery,
  renderProviderAccountQuery,
  renderProviderAccountsQuery,
  renderUpdateFollowedResourceQuery,
  renderUpdateProviderAccountQuery
} from "@knpkv/control-center-sql"
import * as Context from "effect/Context"
import * as Crypto from "effect/Crypto"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import type { Success } from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as SqlSchema from "effect/unstable/sql/SqlSchema"

import { FollowedResourceId, ProviderAccountId, WorkspaceId } from "../../../domain/identifiers.js"
import { ProviderId } from "../../../domain/sourceRevision.js"
import { UtcTimestamp } from "../../../domain/utcTimestamp.js"
import { Database } from "../Database.js"
import { PersistedRecordError, RecordAlreadyExistsError, RecordNotFoundError } from "../errors.js"
import {
  mapAlreadyExists,
  mapPersistenceOperation,
  readChanges,
  resolveCasFailure,
  revisionLookup
} from "./internal.js"
import {
  FollowedResourceDisplayName,
  FollowedResourceRecord,
  ProviderAccountDisplayName,
  ProviderAccountRecord,
  ProviderFamily,
  RecordRevision,
  VendorAccountId,
  VendorResourceId
} from "./models.js"
import { makePersistedRowQuarantine } from "./persistedRowQuarantine.js"
import { QuarantineRepository } from "./quarantineRepository.js"

/** Invalid provider/resource combination rejected before persistence. */
export class ProviderAccountInputError extends Schema.TaggedErrorClass<ProviderAccountInputError>()(
  "ProviderAccountInputError",
  {
    operation: Schema.Literals(["follow-resource"]),
    reason: Schema.Literals(["provider-family-mismatch"])
  }
) {}

const ProviderAccountKey = Schema.Struct({
  workspaceId: WorkspaceId,
  providerAccountId: ProviderAccountId
})

const FollowedResourceKey = Schema.Struct({
  workspaceId: WorkspaceId,
  followedResourceId: FollowedResourceId
})

const CreateProviderAccountRequest = Schema.Struct({
  ...ProviderAccountKey.fields,
  providerFamily: ProviderFamily,
  vendorAccountId: VendorAccountId,
  displayName: ProviderAccountDisplayName,
  createdAt: UtcTimestamp
})

const UpdateProviderAccountRequest = Schema.Struct({
  ...ProviderAccountKey.fields,
  displayName: ProviderAccountDisplayName,
  expectedRevision: RecordRevision,
  updatedAt: UtcTimestamp
})

const CreateFollowedResourceRequest = Schema.Struct({
  ...FollowedResourceKey.fields,
  providerAccountId: ProviderAccountId,
  providerId: ProviderId,
  vendorResourceId: VendorResourceId,
  displayName: FollowedResourceDisplayName,
  isEnabled: Schema.Boolean,
  createdAt: UtcTimestamp
})

const UpdateFollowedResourceRequest = Schema.Struct({
  ...FollowedResourceKey.fields,
  displayName: FollowedResourceDisplayName,
  isEnabled: Schema.Boolean,
  expectedRevision: RecordRevision,
  updatedAt: UtcTimestamp
})

const FollowedResourceRow = Schema.Struct({
  workspaceId: WorkspaceId,
  followedResourceId: FollowedResourceId,
  providerAccountId: ProviderAccountId,
  providerFamily: ProviderFamily,
  providerId: ProviderId,
  vendorResourceId: VendorResourceId,
  displayName: FollowedResourceDisplayName,
  isEnabled: Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 0, maximum: 1 })),
  revision: RecordRevision,
  createdAt: UtcTimestamp,
  updatedAt: UtcTimestamp
})

const providerFamilyFor = (providerId: ProviderId): ProviderFamily => {
  switch (providerId) {
    case "codecommit":
    case "codepipeline":
      return "aws"
    case "jira":
    case "confluence":
      return "atlassian"
    case "clockify":
      return "clockify"
  }
}

const makeProviderAccountRepository = Effect.gen(function*() {
  const cryptoService = yield* Crypto.Crypto
  const database = yield* Database
  const quarantine = yield* QuarantineRepository
  const quarantineRow = makePersistedRowQuarantine(cryptoService, quarantine)
  const sql = database.sql

  const run = (plan: RenderedSql) => sql.unsafe<Record<string, unknown>>(plan.sql, [...plan.params])

  const quarantineMalformed = Effect.fn("ProviderAccountRepository.quarantineMalformed")(function*(
    workspaceId: WorkspaceId,
    recordKind: "provider-account" | "followed-resource",
    recordKey: string,
    row: unknown
  ) {
    yield* quarantineRow({
      workspaceId,
      recordKind,
      recordKey,
      diagnosticCode: `${recordKind}-schema-invalid`,
      diagnosticSummary: `Stored ${recordKind} failed schema validation.`,
      observedAt: yield* DateTime.now,
      row
    })
  })

  const decodeProviderAccount = Effect.fn("ProviderAccountRepository.decodeProviderAccount")(function*(
    workspaceId: WorkspaceId,
    fallbackKey: string,
    row: unknown
  ) {
    const decoded = Schema.decodeUnknownResult(ProviderAccountRecord)(row)
    if (Result.isSuccess(decoded)) return decoded.success
    yield* quarantineMalformed(workspaceId, "provider-account", fallbackKey, row)
    return yield* new PersistedRecordError({
      workspaceId,
      recordKind: "provider-account",
      recordKey: fallbackKey,
      diagnosticCode: "provider-account-schema-invalid"
    })
  })

  const decodeFollowedResource = Effect.fn("ProviderAccountRepository.decodeFollowedResource")(function*(
    workspaceId: WorkspaceId,
    fallbackKey: string,
    row: unknown
  ) {
    const decoded = Schema.decodeUnknownResult(FollowedResourceRow)(row)
    if (Result.isSuccess(decoded)) {
      return yield* Schema.decodeUnknownEffect(Schema.toType(FollowedResourceRecord))({
        ...decoded.success,
        isEnabled: decoded.success.isEnabled === 1
      })
    }
    yield* quarantineMalformed(workspaceId, "followed-resource", fallbackKey, row)
    return yield* new PersistedRecordError({
      workspaceId,
      recordKind: "followed-resource",
      recordKey: fallbackKey,
      diagnosticCode: "followed-resource-schema-invalid"
    })
  })

  const get = Effect.fn("ProviderAccountRepository.get")(function*(
    workspaceId: WorkspaceId,
    providerAccountId: ProviderAccountId
  ) {
    const rows = yield* run(renderProviderAccountQuery({ workspaceId, providerAccountId })).pipe(
      mapPersistenceOperation("provider-account.get")
    )
    if (rows.length === 0) {
      return yield* new RecordNotFoundError({
        workspaceId,
        recordKind: "provider-account",
        recordKey: providerAccountId
      })
    }
    return yield* decodeProviderAccount(workspaceId, providerAccountId, rows[0])
  })

  const getResource = Effect.fn("ProviderAccountRepository.getResource")(function*(
    workspaceId: WorkspaceId,
    followedResourceId: FollowedResourceId
  ) {
    const rows = yield* run(renderFollowedResourceQuery({ workspaceId, followedResourceId })).pipe(
      mapPersistenceOperation("followed-resource.get")
    )
    if (rows.length === 0) {
      return yield* new RecordNotFoundError({
        workspaceId,
        recordKind: "followed-resource",
        recordKey: followedResourceId
      })
    }
    return yield* decodeFollowedResource(workspaceId, followedResourceId, rows[0])
  })

  const insertAccount = SqlSchema.void({
    Request: CreateProviderAccountRequest,
    execute: (request) => run(renderCreateProviderAccountQuery(request))
  })

  const updateAccount = SqlSchema.void({
    Request: UpdateProviderAccountRequest,
    execute: (request) => run(renderUpdateProviderAccountQuery(request))
  })

  const insertResource = SqlSchema.void({
    Request: Schema.Struct({ ...CreateFollowedResourceRequest.fields, providerFamily: ProviderFamily }),
    execute: (request) => run(renderCreateFollowedResourceQuery(request))
  })

  const updateResource = SqlSchema.void({
    Request: UpdateFollowedResourceRequest,
    execute: (request) => run(renderUpdateFollowedResourceQuery(request))
  })

  return {
    create: Effect.fn("ProviderAccountRepository.create")(function*(
      workspaceId: WorkspaceId,
      input: Omit<typeof CreateProviderAccountRequest.Type, "workspaceId">
    ) {
      yield* database.transaction(
        Effect.gen(function*() {
          const existing = yield* run(renderProviderAccountIdentityQuery({
            workspaceId,
            providerFamily: input.providerFamily,
            vendorAccountId: input.vendorAccountId
          }))
          if (existing.length > 0) {
            return yield* new RecordAlreadyExistsError({
              workspaceId,
              recordKind: "provider-account",
              recordKey: input.providerAccountId
            })
          }
          yield* insertAccount({ workspaceId, ...input }).pipe(
            mapAlreadyExists({
              workspaceId,
              recordKind: "provider-account",
              recordKey: input.providerAccountId
            })
          )
        })
      ).pipe(mapPersistenceOperation("provider-account.create"))
      return yield* get(workspaceId, input.providerAccountId)
    }),
    get,
    list: Effect.fn("ProviderAccountRepository.list")(function*(workspaceId: WorkspaceId) {
      const rows = yield* run(renderProviderAccountsQuery(workspaceId)).pipe(
        mapPersistenceOperation("provider-account.list")
      )
      const records: Array<ProviderAccountRecord> = []
      for (const row of rows) {
        records.push(yield* decodeProviderAccount(workspaceId, workspaceId, row))
      }
      return records
    }),
    updateMetadata: Effect.fn("ProviderAccountRepository.updateMetadata")(function*(
      workspaceId: WorkspaceId,
      providerAccountId: ProviderAccountId,
      input: Omit<typeof UpdateProviderAccountRequest.Type, "workspaceId" | "providerAccountId">
    ) {
      yield* database.transaction(
        Effect.gen(function*() {
          yield* updateAccount({ workspaceId, providerAccountId, ...input })
          if ((yield* readChanges(sql)) === 0) {
            return yield* resolveCasFailure({
              workspaceId,
              recordKind: "provider-account",
              recordKey: providerAccountId,
              expectedRevision: input.expectedRevision,
              findActualRevision: revisionLookup(() =>
                sql`SELECT revision FROM provider_accounts
                    WHERE workspace_id = ${workspaceId}
                      AND provider_account_id = ${providerAccountId}`
              )
            })
          }
        })
      ).pipe(mapPersistenceOperation("provider-account.update"))
      return yield* get(workspaceId, providerAccountId)
    }),
    followResource: Effect.fn("ProviderAccountRepository.followResource")(function*(
      workspaceId: WorkspaceId,
      input: Omit<typeof CreateFollowedResourceRequest.Type, "workspaceId">
    ) {
      const account = yield* get(workspaceId, input.providerAccountId)
      if (providerFamilyFor(input.providerId) !== account.providerFamily) {
        return yield* new ProviderAccountInputError({
          operation: "follow-resource",
          reason: "provider-family-mismatch"
        })
      }
      yield* insertResource({ workspaceId, providerFamily: account.providerFamily, ...input }).pipe(
        mapAlreadyExists({
          workspaceId,
          recordKind: "followed-resource",
          recordKey: input.followedResourceId
        }),
        mapPersistenceOperation("followed-resource.create")
      )
      return yield* getResource(workspaceId, input.followedResourceId)
    }),
    getResource,
    listResources: Effect.fn("ProviderAccountRepository.listResources")(function*(
      workspaceId: WorkspaceId,
      providerAccountId: ProviderAccountId
    ) {
      yield* get(workspaceId, providerAccountId)
      const rows = yield* run(renderFollowedResourcesQuery(workspaceId, providerAccountId)).pipe(
        mapPersistenceOperation("followed-resource.list")
      )
      const records: Array<FollowedResourceRecord> = []
      for (const row of rows) {
        records.push(yield* decodeFollowedResource(workspaceId, workspaceId, row))
      }
      return records
    }),
    updateResourceMetadata: Effect.fn("ProviderAccountRepository.updateResourceMetadata")(function*(
      workspaceId: WorkspaceId,
      followedResourceId: FollowedResourceId,
      input: Omit<typeof UpdateFollowedResourceRequest.Type, "workspaceId" | "followedResourceId">
    ) {
      yield* database.transaction(
        Effect.gen(function*() {
          yield* updateResource({ workspaceId, followedResourceId, ...input })
          if ((yield* readChanges(sql)) === 0) {
            return yield* resolveCasFailure({
              workspaceId,
              recordKind: "followed-resource",
              recordKey: followedResourceId,
              expectedRevision: input.expectedRevision,
              findActualRevision: revisionLookup(() =>
                sql`SELECT revision FROM followed_resources
                    WHERE workspace_id = ${workspaceId}
                      AND followed_resource_id = ${followedResourceId}`
              )
            })
          }
        })
      ).pipe(mapPersistenceOperation("followed-resource.update"))
      return yield* getResource(workspaceId, followedResourceId)
    })
  }
})

/** Provider accounts with their independently followed resources. */
export interface ProviderAccountRepositoryService extends Success<typeof makeProviderAccountRepository> {}

/** Effect service for provider-account and followed-resource persistence. */
export class ProviderAccountRepository extends Context.Service<
  ProviderAccountRepository,
  ProviderAccountRepositoryService
>()("@knpkv/control-center/ProviderAccountRepository") {
  /** Layer binding account and resource plans to the shared database. */
  static readonly layer = Layer.effect(ProviderAccountRepository, makeProviderAccountRepository)
}
