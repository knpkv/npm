import * as Arr from "effect/Array"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

import { evidenceFreshnessAt, type EvidenceItem } from "../../../../domain/deliveryGraph.js"
import type {
  GovernedActionEvidenceReference,
  GovernedActionEvidenceSet
} from "../../../../domain/governedAction/index.js"
import type { WorkspaceId } from "../../../../domain/identifiers.js"
import { EvidenceClaimId } from "../../../../domain/identifiers.js"
import type { UtcTimestamp } from "../../../../domain/utcTimestamp.js"
import { Database } from "../../../persistence/Database.js"
import { PersistedRecordError } from "../../../persistence/errors.js"
import { makeDeliveryGraphDecoders } from "../../../persistence/repositories/delivery-graph/decode.js"
import { ClaimRow, decodeRows, EvidenceRow } from "../../../persistence/repositories/delivery-graph/rows.js"

const CLAIM_BATCH_SIZE = 400

const CurrentClaimRow = Schema.Struct({
  ...ClaimRow.fields,
  successorEvidenceClaimId: Schema.NullOr(EvidenceClaimId)
})

type EvidenceReference = typeof GovernedActionEvidenceReference.Type
type CurrentClaimRow = typeof CurrentClaimRow.Type

/** A persisted evidence set no longer grants the same current dispatch authority. */
export class GovernedActionCurrentEvidenceRejected extends Schema.TaggedErrorClass<
  GovernedActionCurrentEvidenceRejected
>()("GovernedActionCurrentEvidenceRejected", {
  reason: Schema.Literals([
    "claim-changed",
    "claim-missing",
    "evidence-changed",
    "evidence-missing",
    "evidence-not-current"
  ])
}) {}

const invalidEvidence = (
  workspaceId: WorkspaceId,
  recordKey: string,
  diagnosticCode: string
) =>
  new PersistedRecordError({
    workspaceId,
    recordKind: "governed-action-evidence",
    recordKey,
    diagnosticCode
  })

const sameInstant = (left: UtcTimestamp, right: UtcTimestamp): boolean => DateTime.Order(left, right) === 0

const sameOptionalInstant = (
  left: UtcTimestamp | null,
  right: UtcTimestamp | null
): boolean => left === null || right === null ? left === right : sameInstant(left, right)

const expectedCurrentUntil = (evidence: EvidenceItem): UtcTimestamp | null =>
  evidence.freshness._tag === "current"
    ? DateTime.add(evidence.freshness.sourceObservedAt, {
      seconds: evidence.freshness.staleAfterSeconds
    })
    : null

const validateEvidenceReference = Effect.fn(
  "GovernedActionCurrentEvidenceReader.validateReference"
)(function*(input: {
  readonly reference: EvidenceReference
  readonly evidence: EvidenceItem
  readonly now: UtcTimestamp
}) {
  const { evidence, now, reference } = input
  const atProposal = evidenceFreshnessAt(evidence, reference.evaluatedAt)
  const currentUntil = expectedCurrentUntil(evidence)
  if (
    evidence.workspaceId !== reference.workspaceId ||
    evidence.evidenceId !== reference.evidenceId ||
    !sameInstant(evidence.observedAt, reference.observedAt) ||
    !sameOptionalInstant(evidence.validUntil, reference.validUntil) ||
    DateTime.Order(evidence.recordedAt, reference.evaluatedAt) > 0 ||
    atProposal.source !== reference.source ||
    atProposal.validity !== reference.validity ||
    !sameOptionalInstant(currentUntil, reference.currentUntil)
  ) {
    return yield* new GovernedActionCurrentEvidenceRejected({ reason: "evidence-changed" })
  }
  const current = evidenceFreshnessAt(evidence, now)
  if (current.source !== "current" || current.validity !== "valid") {
    return yield* new GovernedActionCurrentEvidenceRejected({ reason: "evidence-not-current" })
  }
})

/** Strict current evidence reader used only inside the atomic dispatch-authority transaction. */
export const makeGovernedActionCurrentEvidenceReader = Effect.gen(function*() {
  const { sql } = yield* Database
  const decoders = yield* makeDeliveryGraphDecoders

  const read = Effect.fn("GovernedActionCurrentEvidenceReader.read")(function*(input: {
    readonly workspaceId: WorkspaceId
    readonly evidence: GovernedActionEvidenceSet
    readonly now: UtcTimestamp
  }) {
    if (input.evidence.length === 0) return input.evidence

    const evidenceIds = input.evidence.map(({ evidenceId }) => evidenceId)
    const rawEvidenceRows = yield* sql`SELECT
      workspace_id AS workspaceId,
      evidence_id AS evidenceId,
      schema_version AS schemaVersion,
      evidence_digest AS evidenceDigest,
      origin_kind AS originKind,
      plugin_connection_id AS pluginConnectionId,
      source_entity_id AS sourceEntityId,
      source_entity_revision AS sourceEntityRevision,
      person_id AS personId,
      agent_id AS agentId,
      system_component AS systemComponent,
      verifier_kind AS verifierKind,
      verifier_person_id AS verifierPersonId,
      verifier_agent_id AS verifierAgentId,
      verifier_component AS verifierComponent,
      observed_at AS observedAt,
      recorded_at AS recordedAt,
      valid_until AS validUntil,
      freshness_json AS freshnessJson,
      freshness_digest AS freshnessDigest,
      retention_class AS retentionClass,
      retain_until AS retainUntil,
      legal_hold AS legalHold
    FROM evidence_items
    WHERE workspace_id = ${input.workspaceId}
      AND evidence_id IN ${sql.in(evidenceIds)}
    ORDER BY evidence_id`
    const evidenceRows = yield* decodeRows(EvidenceRow, rawEvidenceRows).pipe(
      Effect.mapError(() => invalidEvidence(input.workspaceId, "evidence-set", "evidence-row-invalid"))
    )
    if (evidenceRows.length !== input.evidence.length) {
      return yield* new GovernedActionCurrentEvidenceRejected({ reason: "evidence-missing" })
    }
    const evidenceItems = yield* Effect.forEach(evidenceRows, decoders.decodeEvidenceRow)
    const evidenceById = new Map(evidenceItems.map((evidence) => [evidence.evidenceId, evidence]))
    if (evidenceById.size !== input.evidence.length) {
      return yield* invalidEvidence(input.workspaceId, "evidence-set", "evidence-identity-ambiguous")
    }

    const claimIds = input.evidence.flatMap(({ evidenceClaimIds }) => evidenceClaimIds)
    const rawClaimBatches = yield* Effect.forEach(
      Arr.chunksOf(claimIds, CLAIM_BATCH_SIZE),
      (batch) =>
        sql`SELECT
          claim.workspace_id AS workspaceId,
          claim.evidence_claim_id AS evidenceClaimId,
          claim.evidence_id AS evidenceId,
          claim.subject_node_id AS subjectNodeId,
          claim.predicate,
          claim.value_json AS valueJson,
          claim.value_digest AS valueDigest,
          claim.supersedes_claim_id AS supersedesEvidenceClaimId,
          claim.recorded_at AS recordedAt,
          successor.evidence_claim_id AS successorEvidenceClaimId
        FROM evidence_claims claim
        LEFT JOIN evidence_claims successor
          ON successor.workspace_id = claim.workspace_id
          AND successor.supersedes_claim_id = claim.evidence_claim_id
        WHERE claim.workspace_id = ${input.workspaceId}
          AND claim.evidence_claim_id IN ${sql.in(batch)}
        ORDER BY claim.evidence_claim_id`
    )
    const claimRows = yield* decodeRows(CurrentClaimRow, Arr.flatten(rawClaimBatches)).pipe(
      Effect.mapError(() => invalidEvidence(input.workspaceId, "claim-set", "evidence-claim-row-invalid"))
    )
    if (claimRows.length !== claimIds.length) {
      return yield* new GovernedActionCurrentEvidenceRejected({ reason: "claim-missing" })
    }
    const claims = yield* Effect.forEach(claimRows, (row) =>
      decoders.decodeClaimRow(row).pipe(
        Effect.map((claim) => ({ claim, successorEvidenceClaimId: row.successorEvidenceClaimId }))
      ))
    const claimsById = new Map(claims.map((claim) => [claim.claim.evidenceClaimId, claim]))
    if (claimsById.size !== claimIds.length) {
      return yield* invalidEvidence(input.workspaceId, "claim-set", "evidence-claim-identity-ambiguous")
    }

    yield* Effect.forEach(input.evidence, (reference) =>
      Effect.gen(function*() {
        const evidence = evidenceById.get(reference.evidenceId)
        if (evidence === undefined) {
          return yield* new GovernedActionCurrentEvidenceRejected({ reason: "evidence-missing" })
        }
        yield* validateEvidenceReference({ reference, evidence, now: input.now })
        yield* Effect.forEach(reference.evidenceClaimIds, (claimId) => {
          const current = claimsById.get(claimId)
          return current === undefined
            ? Effect.fail(new GovernedActionCurrentEvidenceRejected({ reason: "claim-missing" }))
            : current.claim.evidenceId !== reference.evidenceId ||
                current.successorEvidenceClaimId !== null ||
                DateTime.Order(current.claim.recordedAt, reference.evaluatedAt) > 0
            ? Effect.fail(new GovernedActionCurrentEvidenceRejected({ reason: "claim-changed" }))
            : Effect.void
        }, { discard: true })
      }), { discard: true })

    return input.evidence
  })

  return { read }
})
