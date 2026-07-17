import * as BrowserCrypto from "@effect/platform-browser/BrowserCrypto"
import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"

import { makeControlCenterApiClient } from "../../api/client.js"
import type {
  ApplyRelationshipRepairProposalResponse,
  RelationshipRepairProposalList
} from "../../api/deliveryGraph.js"
import type {
  EnvironmentId,
  RelationshipRepairProposalId,
  RelationshipRepairReviewId,
  ReleaseId
} from "../../domain/identifiers.js"
import { RelationshipRepairReviewId as RelationshipRepairReviewIdSchema } from "../../domain/identifiers.js"
import type { RelationshipRepairProposal, RelationshipRepairReviewDecision } from "../../domain/relationshipRepair.js"
import { makeAuthenticatedMutationClient } from "../authenticatedMutationClient.js"

/** Generate a browser-native UUID v7 without weakening the public identifier contract. */
export const makeRelationshipRepairReviewId = Effect.gen(function*() {
  const cryptoService = yield* Crypto.Crypto
  const uuid = yield* cryptoService.randomUUIDv7
  return yield* Schema.decodeUnknownEffect(RelationshipRepairReviewIdSchema)(uuid)
})

export interface RelationshipRepairTransport {
  readonly apply: (
    proposalId: RelationshipRepairProposalId,
    signal: AbortSignal
  ) => Promise<ApplyRelationshipRepairProposalResponse>
  readonly list: (
    releaseId: ReleaseId,
    environmentId: EnvironmentId | null,
    signal: AbortSignal
  ) => Promise<RelationshipRepairProposalList>
  readonly makeReviewId: () => Promise<RelationshipRepairReviewId>
  readonly review: (
    proposalId: RelationshipRepairProposalId,
    reviewId: RelationshipRepairReviewId,
    decision: RelationshipRepairReviewDecision,
    rationale: string,
    signal: AbortSignal
  ) => Promise<RelationshipRepairProposal>
}

/** Generated-client transport for the release repair decision ledger. */
export const browserRelationshipRepairTransport: RelationshipRepairTransport = {
  apply: (proposalId, signal) =>
    Effect.runPromise(
      Effect.gen(function*() {
        const client = yield* makeAuthenticatedMutationClient
        return yield* client.deliveryGraph.applyRepairProposal({ params: { proposalId } })
      }).pipe(Effect.provide(FetchHttpClient.layer)),
      { signal }
    ),
  list: (releaseId, environmentId, signal) =>
    Effect.runPromise(
      Effect.gen(function*() {
        const client = yield* makeControlCenterApiClient()
        return yield* client.deliveryGraph.listRepairProposals({
          params: { releaseId },
          query: environmentId === null ? {} : { environmentId }
        })
      }).pipe(Effect.provide(FetchHttpClient.layer)),
      { signal }
    ),
  makeReviewId: () => Effect.runPromise(makeRelationshipRepairReviewId.pipe(Effect.provide(BrowserCrypto.layer))),
  review: (proposalId, reviewId, decision, rationale, signal) =>
    Effect.runPromise(
      Effect.gen(function*() {
        const client = yield* makeAuthenticatedMutationClient
        return yield* client.deliveryGraph.reviewRepairProposal({
          params: { proposalId },
          payload: {
            reviewId,
            decision,
            rationale
          }
        })
      }).pipe(Effect.provide(FetchHttpClient.layer)),
      { signal }
    )
}
