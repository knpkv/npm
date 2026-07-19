import type * as Crypto from "effect/Crypto"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"

import { FollowedResourceId, ProviderAccountId } from "../../domain/identifiers.js"
import type { PluginDiscoveryV1 } from "../../domain/plugins/discovery.js"
import { ApplicationInvalidRequest, ApplicationServiceUnavailable } from "../api/ApplicationServices.js"
import { RecordAlreadyExistsError } from "../persistence/errors.js"
import type { Persistence } from "../persistence/Persistence.js"
import type { PluginConnectionRecord, ProviderFamily } from "../persistence/repositories/models.js"
import {
  FollowedResourceDisplayName,
  ProviderAccountDisplayName,
  VendorAccountId,
  VendorResourceId
} from "../persistence/repositories/models.js"
import { mapPersistenceWriteError } from "./errors.js"

interface OwnershipDiscovery {
  readonly account: NonNullable<PluginDiscoveryV1["account"]>
  readonly providerFamily: ProviderFamily
  readonly resource: NonNullable<PluginDiscoveryV1["resource"]>
}

const ownershipDiscovery = (
  connection: PluginConnectionRecord,
  discovery: PluginDiscoveryV1 | null
): OwnershipDiscovery | null | undefined => {
  switch (connection.providerId) {
    case "codecommit":
    case "codepipeline":
      return discovery === null || discovery.account === null || discovery.resource === null
        ? undefined
        : { account: discovery.account, providerFamily: "aws", resource: discovery.resource }
    case "jira":
    case "confluence":
      return discovery === null || discovery.workspace === null || discovery.resource === null
        ? null
        : { account: discovery.workspace, providerFamily: "atlassian", resource: discovery.resource }
    case "clockify":
      return null
  }
}

const unavailable = (): ApplicationServiceUnavailable => new ApplicationServiceUnavailable({ retryAt: null })

/** Bind a healthy connection to its provider-discovered account and resource identities. */
export const materializeConnectionOwnership = Effect.fn(
  "PluginAdministration.materializeConnectionOwnership"
)(function*(
  persistence: Persistence["Service"],
  cryptoService: Crypto.Crypto,
  connection: PluginConnectionRecord,
  discovery: PluginDiscoveryV1 | null
) {
  const ownership = ownershipDiscovery(connection, discovery)
  if (ownership === null) return connection
  if (ownership === undefined) return yield* new ApplicationInvalidRequest()

  const materializedAt = yield* DateTime.now
  const candidateAccountId = ProviderAccountId.make(
    yield* cryptoService.randomUUIDv7.pipe(Effect.mapError(() => unavailable()))
  )
  const candidateResourceId = FollowedResourceId.make(
    yield* cryptoService.randomUUIDv7.pipe(Effect.mapError(() => unavailable()))
  )
  return yield* persistence.transact(Effect.gen(function*() {
    const accounts = yield* persistence.providerAccounts.list(connection.workspaceId)
    const accountIdentity = VendorAccountId.make(ownership.account.providerImmutableId)
    const account = accounts.find(
      (candidate) =>
        candidate.providerFamily === ownership.providerFamily && candidate.vendorAccountId === accountIdentity
    ) ?? (yield* persistence.providerAccounts.create(connection.workspaceId, {
      providerAccountId: candidateAccountId,
      providerFamily: ownership.providerFamily,
      vendorAccountId: accountIdentity,
      displayName: ProviderAccountDisplayName.make(ownership.account.displayName),
      createdAt: materializedAt
    }))

    const resources = yield* persistence.providerAccounts.listResources(
      connection.workspaceId,
      account.providerAccountId
    )
    const resourceIdentity = VendorResourceId.make(ownership.resource.providerImmutableId)
    const resource = resources.find(
      (candidate) => candidate.providerId === connection.providerId && candidate.vendorResourceId === resourceIdentity
    ) ?? (yield* persistence.providerAccounts.followResource(connection.workspaceId, {
      followedResourceId: candidateResourceId,
      providerAccountId: account.providerAccountId,
      providerId: connection.providerId,
      vendorResourceId: resourceIdentity,
      displayName: FollowedResourceDisplayName.make(ownership.resource.displayName),
      isEnabled: true,
      createdAt: materializedAt
    }))

    const connections = yield* persistence.pluginConnections.list(connection.workspaceId)
    if (connections.some((candidate) => candidate.followedResourceId === resource.followedResourceId)) {
      return yield* new RecordAlreadyExistsError({
        workspaceId: connection.workspaceId,
        recordKind: "plugin-connection-resource",
        recordKey: resource.followedResourceId
      })
    }

    return yield* persistence.pluginConnections.bindResource(
      connection.workspaceId,
      connection.pluginConnectionId,
      {
        providerAccountId: account.providerAccountId,
        followedResourceId: resource.followedResourceId,
        expectedRevision: connection.revision,
        updatedAt: materializedAt
      }
    )
  })).pipe(Effect.mapError(mapPersistenceWriteError))
})
