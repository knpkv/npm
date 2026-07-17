import * as BrowserCrypto from "@effect/platform-browser/BrowserCrypto"
import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"

import { makeControlCenterApiClient } from "../../api/client.js"
import type { RelationshipRepairCandidates, RelationshipRepairProposalDraft } from "../../api/deliveryGraph.js"
import type { LedgerRevision } from "../../domain/deliveryGraph.js"
import type {
  EnvironmentId,
  RelationshipId,
  RelationshipRepairProposalId,
  ReleaseId
} from "../../domain/identifiers.js"
import { RelationshipRepairProposalId as RelationshipRepairProposalIdSchema } from "../../domain/identifiers.js"
import type { RelationshipRepairProposal } from "../../domain/relationshipRepair.js"
import { makeAuthenticatedMutationClient } from "../authenticatedMutationClient.js"

/** Generate one canonical proposal identity at the browser mutation boundary. */
export const makeRelationshipRepairProposalId = Effect.gen(function*() {
  const cryptoService = yield* Crypto.Crypto
  const uuid = yield* cryptoService.randomUUIDv7
  return yield* Schema.decodeUnknownEffect(RelationshipRepairProposalIdSchema)(uuid)
})

export interface RelationshipRepairCandidateTransport {
  readonly create: (
    releaseId: ReleaseId,
    draft: RelationshipRepairProposalDraft,
    proposalId: RelationshipRepairProposalId,
    signal: AbortSignal
  ) => Promise<RelationshipRepairProposal>
  readonly draft: (
    releaseId: ReleaseId,
    environmentId: EnvironmentId | null,
    relationshipId: RelationshipId,
    revision: LedgerRevision,
    signal: AbortSignal
  ) => Promise<RelationshipRepairProposalDraft>
  readonly list: (
    releaseId: ReleaseId,
    environmentId: EnvironmentId | null,
    signal: AbortSignal
  ) => Promise<RelationshipRepairCandidates>
  readonly makeProposalId: () => Promise<RelationshipRepairProposalId>
}

/** Generated-client transport for owner-governed repair candidate creation. */
export const browserRelationshipRepairCandidateTransport: RelationshipRepairCandidateTransport = {
  create: (releaseId, draft, proposalId, signal) =>
    Effect.runPromise(
      Effect.gen(function*() {
        const client = yield* makeAuthenticatedMutationClient
        return yield* client.deliveryGraph.createRepairProposal({
          params: {
            releaseId,
            relationshipId: draft.precondition.relationshipId
          },
          payload: {
            proposalId,
            environmentId: draft.candidate.impact.environmentId,
            expectedRevision: draft.precondition.expectedRevision,
            disposition: draft.proposal.disposition,
            rationale: draft.proposal.rationale
          }
        })
      }).pipe(Effect.provide(FetchHttpClient.layer)),
      { signal }
    ),
  draft: (releaseId, environmentId, relationshipId, revision, signal) =>
    Effect.runPromise(
      Effect.gen(function*() {
        const client = yield* makeControlCenterApiClient()
        return yield* client.deliveryGraph.repairProposalDraft({
          params: { releaseId, relationshipId },
          query: environmentId === null ? { revision } : { environmentId, revision }
        })
      }).pipe(Effect.provide(FetchHttpClient.layer)),
      { signal }
    ),
  list: (releaseId, environmentId, signal) =>
    Effect.runPromise(
      Effect.gen(function*() {
        const client = yield* makeControlCenterApiClient()
        return yield* client.deliveryGraph.repairCandidates({
          params: { releaseId },
          query: environmentId === null ? {} : { environmentId }
        })
      }).pipe(Effect.provide(FetchHttpClient.layer)),
      { signal }
    ),
  makeProposalId: () => Effect.runPromise(makeRelationshipRepairProposalId.pipe(Effect.provide(BrowserCrypto.layer)))
}
