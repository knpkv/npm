import type * as Crypto from "effect/Crypto"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"

import { FollowedResourceId, ProviderAccountId } from "../../domain/identifiers.js"
import type { PluginDiscoveryV1 } from "../../domain/plugins/discovery.js"
import { ApplicationInvalidRequest, ApplicationServiceUnavailable } from "../api/ApplicationServices.js"
import { RecordAlreadyExistsError } from "../persistence/errors.js"
import type { Persistence } from "../persistence/Persistence.js"
import type { PluginConnectionRecord } from "../persistence/repositories/models.js"
import {
  FollowedResourceDisplayName,
  ProviderAccountDisplayName,
  VendorAccountId,
  VendorResourceId
} from "../persistence/repositories/models.js"
import { mapPersistenceWriteError } from "./errors.js"

const isAwsProvider = (
  providerId: PluginConnectionRecord["providerId"]
): providerId is Extract<PluginConnectionRecord["providerId"], "codecommit" | "codepipeline"> =>
  providerId === "codecommit" || providerId === "codepipeline"

const unavailable = (): ApplicationServiceUnavailable => new ApplicationServiceUnavailable({ retryAt: null })

/** Bind a healthy AWS connection to its provider-discovered account and resource identities. */
export const materializeAwsConnectionOwnership = Effect.fn(
  "PluginAdministration.materializeAwsConnectionOwnership"
)(function*(
  persistence: Persistence["Service"],
  cryptoService: Crypto.Crypto,
  connection: PluginConnectionRecord,
  discovery: PluginDiscoveryV1 | null
) {
  if (!isAwsProvider(connection.providerId)) return connection
  if (discovery === null || discovery.account === null || discovery.workspace === null) {
    return yield* new ApplicationInvalidRequest()
  }

  const discoveredAccount = discovery.account
  const discoveredResource = discovery.workspace
  const materializedAt = yield* DateTime.now
  const candidateAccountId = ProviderAccountId.make(
    yield* cryptoService.randomUUIDv7.pipe(Effect.mapError(() => unavailable()))
  )
  const candidateResourceId = FollowedResourceId.make(
    yield* cryptoService.randomUUIDv7.pipe(Effect.mapError(() => unavailable()))
  )
  return yield* persistence.transact(Effect.gen(function*() {
    const accounts = yield* persistence.providerAccounts.list(connection.workspaceId)
    const accountIdentity = VendorAccountId.make(discoveredAccount.providerImmutableId)
    const account = accounts.find(
      (candidate) => candidate.providerFamily === "aws" && candidate.vendorAccountId === accountIdentity
    ) ?? (yield* persistence.providerAccounts.create(connection.workspaceId, {
      providerAccountId: candidateAccountId,
      providerFamily: "aws",
      vendorAccountId: accountIdentity,
      displayName: ProviderAccountDisplayName.make(discoveredAccount.displayName),
      createdAt: materializedAt
    }))

    const resources = yield* persistence.providerAccounts.listResources(
      connection.workspaceId,
      account.providerAccountId
    )
    const resourceIdentity = VendorResourceId.make(discoveredResource.providerImmutableId)
    const resource = resources.find((candidate) =>
      candidate.providerId === connection.providerId && candidate.vendorResourceId === resourceIdentity
    ) ?? (yield* persistence.providerAccounts.followResource(connection.workspaceId, {
      followedResourceId: candidateResourceId,
      providerAccountId: account.providerAccountId,
      providerId: connection.providerId,
      vendorResourceId: resourceIdentity,
      displayName: FollowedResourceDisplayName.make(discoveredResource.displayName),
      isEnabled: true,
      createdAt: materializedAt
    }))

    const connections = yield* persistence.pluginConnections.list(connection.workspaceId)
    if (
      connections.some((candidate) =>
        candidate.followedResourceId === resource.followedResourceId
      )
    ) {
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
