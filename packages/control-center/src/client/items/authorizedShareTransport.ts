import * as BrowserCrypto from "@effect/platform-browser/BrowserCrypto"
import * as Crypto from "effect/Crypto"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"

import { makeControlCenterApiClient } from "../../api/client.js"
import type { AuthorizedShareResolution, AuthorizedShareSummary } from "../../api/shares.js"
import type { EntityId, PersonId, ShareId, WorkspaceId } from "../../domain/identifiers.js"
import { ShareId as ShareIdSchema } from "../../domain/identifiers.js"
import type { UtcTimestamp } from "../../domain/utcTimestamp.js"
import { makeAuthenticatedMutationClient } from "../authenticatedMutationClient.js"

export type AuthorizedShareLifetime = "hour" | "day" | "week"

/** Exact share creation intent supplied to the generated browser transport. */
export interface PrepareAuthorizedShareTransportInput {
  readonly entityId: EntityId
  readonly granteePersonId: PersonId
  readonly lifetime: AuthorizedShareLifetime
}

/** Retry-stable share creation intent, including its original identity and expiry. */
export interface CreateAuthorizedShareTransportInput extends PrepareAuthorizedShareTransportInput {
  readonly expiresAt: UtcTimestamp
  readonly shareId: ShareId
}

const expiresAtFor = Effect.fn("AuthorizedShareTransport.expiresAtFor")(function*(lifetime: AuthorizedShareLifetime) {
  const now = yield* DateTime.now
  switch (lifetime) {
    case "hour":
      return DateTime.add(now, { hours: 1 })
    case "day":
      return DateTime.add(now, { days: 1 })
    case "week":
      return DateTime.add(now, { days: 7 })
  }
})

export interface AuthorizedShareTransport {
  readonly create: (
    input: CreateAuthorizedShareTransportInput,
    signal: AbortSignal
  ) => Promise<AuthorizedShareSummary>
  readonly prepareCreate: (
    input: PrepareAuthorizedShareTransportInput
  ) => Promise<CreateAuthorizedShareTransportInput>
  readonly resolve: (
    workspaceId: WorkspaceId,
    shareId: ShareId,
    signal: AbortSignal
  ) => Promise<AuthorizedShareResolution>
  readonly revoke: (workspaceId: WorkspaceId, shareId: ShareId, signal: AbortSignal) => Promise<void>
}

const makeShareId = Effect.gen(function*() {
  const cryptoService = yield* Crypto.Crypto
  const uuid = yield* cryptoService.randomUUIDv7
  return yield* Schema.decodeUnknownEffect(ShareIdSchema)(uuid)
})

const prepareCreate = Effect.fn("AuthorizedShareTransport.prepareCreate")(function*(
  input: PrepareAuthorizedShareTransportInput
) {
  return {
    ...input,
    expiresAt: yield* expiresAtFor(input.lifetime),
    shareId: yield* makeShareId
  }
})

/** Generated-client transport for exact-scope authenticated entity shares. */
export const browserAuthorizedShareTransport: AuthorizedShareTransport = {
  create: (input, signal) =>
    Effect.runPromise(
      Effect.gen(function*() {
        const client = yield* makeAuthenticatedMutationClient
        return yield* client.shares.create({
          payload: {
            entityId: input.entityId,
            expiresAt: input.expiresAt,
            granteePersonId: input.granteePersonId,
            shareId: input.shareId
          }
        })
      }).pipe(Effect.provide(FetchHttpClient.layer)),
      { signal }
    ),
  prepareCreate: (input) => Effect.runPromise(prepareCreate(input).pipe(Effect.provide(BrowserCrypto.layer))),
  resolve: (workspaceId, shareId, signal) =>
    Effect.runPromise(
      Effect.gen(function*() {
        const client = yield* makeControlCenterApiClient()
        return yield* client.shares.resolve({ params: { workspaceId, shareId } })
      }).pipe(Effect.provide(FetchHttpClient.layer)),
      { signal }
    ),
  revoke: (workspaceId, shareId, signal) =>
    Effect.runPromise(
      Effect.gen(function*() {
        const client = yield* makeAuthenticatedMutationClient
        yield* client.shares.revoke({ params: { workspaceId, shareId } })
      }).pipe(Effect.provide(FetchHttpClient.layer)),
      { signal }
    )
}
