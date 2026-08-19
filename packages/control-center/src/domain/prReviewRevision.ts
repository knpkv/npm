/** Immutable revision history for evidence-backed PR-review suggestions. @module */
import { AgentProviderId, AgentRuntimeMetadata } from "@knpkv/ai-runtime"
import * as Schema from "effect/Schema"

import { JobId, PersonId, PrReviewSuggestionRevisionId } from "./identifiers.js"
import { PrReviewSubject, PrReviewSuggestion } from "./prReview.js"
import { UtcTimestamp } from "./utcTimestamp.js"

/** Maximum revisions returned by one bounded history page. */
export const MAXIMUM_PR_REVIEW_SUGGESTION_REVISION_PAGE_SIZE = 128

/** Maximum UTF-8 JSON size of one complete durable suggestion revision. */
export const MAXIMUM_PR_REVIEW_SUGGESTION_REVISION_BYTES = 65_536

/** Strictly positive aggregate-local suggestion revision sequence. */
export const PrReviewSuggestionRevisionSequence = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })
).pipe(Schema.brand("PrReviewSuggestionRevisionSequence"))

/** Decoded aggregate-local suggestion revision sequence. */
export type PrReviewSuggestionRevisionSequence = typeof PrReviewSuggestionRevisionSequence.Type

/** Bounded page size accepted by the suggestion revision repository and API. */
export const PrReviewSuggestionRevisionPageSize = Schema.Int.check(
  Schema.isBetween({
    minimum: 1,
    maximum: MAXIMUM_PR_REVIEW_SUGGESTION_REVISION_PAGE_SIZE
  })
).pipe(Schema.brand("PrReviewSuggestionRevisionPageSize"))

/** Decoded bounded suggestion revision page size. */
export type PrReviewSuggestionRevisionPageSize = typeof PrReviewSuggestionRevisionPageSize.Type

/** Human author of one immutable manual suggestion edit. */
export class PrReviewSuggestionOperatorAuthor extends Schema.TaggedClass<PrReviewSuggestionOperatorAuthor>()(
  "operator",
  { personId: PersonId }
) {}

const AgentModel = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(500)
)

/** Agent provenance retained with one immutable edit or revalidation result. */
export class PrReviewSuggestionAgentAuthor extends Schema.TaggedClass<PrReviewSuggestionAgentAuthor>()(
  "agent",
  {
    jobId: JobId,
    providerId: AgentProviderId,
    model: Schema.NullOr(AgentModel),
    runtimeMetadata: Schema.NullOr(AgentRuntimeMetadata)
  }
) {}

/** Complete author provenance for one suggestion revision. */
export const PrReviewSuggestionRevisionAuthor = Schema.Union([
  PrReviewSuggestionOperatorAuthor,
  PrReviewSuggestionAgentAuthor
]).pipe(Schema.toTaggedUnion("_tag"))

/** Decoded suggestion revision author. */
export type PrReviewSuggestionRevisionAuthor = typeof PrReviewSuggestionRevisionAuthor.Type

/** Evidence for this revision was validated by one exact agent run and head. */
export class PrReviewSuggestionValidated extends Schema.TaggedClass<PrReviewSuggestionValidated>()(
  "validated",
  {
    reviewedHead: PrReviewSubject.fields.headRevision,
    validatingJobId: JobId,
    sourceRevisionId: PrReviewSuggestionRevisionId
  }
) {}

/** Technical content changed and must be checked before publication. */
export class PrReviewSuggestionRequiresRevalidation
  extends Schema.TaggedClass<PrReviewSuggestionRequiresRevalidation>()(
    "requires-revalidation",
    {
      reviewedHead: PrReviewSubject.fields.headRevision,
      sourceRevisionId: PrReviewSuggestionRevisionId,
      reason: Schema.Literals([
        "technical-claim-edited",
        "agent-edit-not-validated"
      ])
    }
  )
{}

/** Exact validation state attached to one immutable suggestion revision. */
export const PrReviewSuggestionRevisionValidation = Schema.Union([
  PrReviewSuggestionValidated,
  PrReviewSuggestionRequiresRevalidation
]).pipe(Schema.toTaggedUnion("_tag"))

/** Decoded suggestion revision validation state. */
export type PrReviewSuggestionRevisionValidation = typeof PrReviewSuggestionRevisionValidation.Type

const editableSuggestionFields = {
  title: PrReviewSuggestion.fields.title,
  severity: PrReviewSuggestion.fields.severity,
  problem: PrReviewSuggestion.fields.problem,
  impact: PrReviewSuggestion.fields.impact,
  evidence: PrReviewSuggestion.fields.evidence,
  recommendation: PrReviewSuggestion.fields.recommendation,
  confidence: PrReviewSuggestion.fields.confidence,
  relatedLocations: PrReviewSuggestion.fields.relatedLocations,
  prevention: PrReviewSuggestion.fields.prevention,
  replacement: PrReviewSuggestion.fields.replacement,
  anchor: PrReviewSuggestion.fields.anchor
}

/** Complete operator- or agent-editable suggestion content. */
export const PrReviewSuggestionEdit = Schema.Struct(editableSuggestionFields)
  .check(
    Schema.makeFilter(
      ({ anchor, confidence, evidence }) =>
        confidence.level !== "low" &&
        (anchor._tag === "changes" ||
          (anchor.path === evidence.path &&
            (anchor._tag === "file" || anchor.line === evidence.startLine))),
      {
        expected: "a medium/high-confidence suggestion whose file or line anchor matches its exact evidence"
      }
    ),
    Schema.makeFilter(
      ({ prevention, severity }) =>
        prevention === undefined ||
        prevention.enforcement === "none" ||
        severity === "P1" ||
        severity === "P2",
      {
        expected: "prevention proposals only for high-impact P1 or P2 defect classes"
      }
    )
  )
  .annotate({ identifier: "PrReviewSuggestionEdit" })

/** Decoded complete suggestion edit. */
export type PrReviewSuggestionEdit = typeof PrReviewSuggestionEdit.Type

/** One complete immutable revision of a stable review suggestion. */
export class PrReviewSuggestionRevision extends Schema.Class<PrReviewSuggestionRevision>(
  "PrReviewSuggestionRevision"
)(
  Schema.Struct({
    revisionId: PrReviewSuggestionRevisionId,
    sequence: PrReviewSuggestionRevisionSequence,
    predecessorRevisionId: Schema.NullOr(PrReviewSuggestionRevisionId),
    sourceJobId: JobId,
    subject: PrReviewSubject,
    suggestion: PrReviewSuggestion,
    validation: PrReviewSuggestionRevisionValidation,
    author: PrReviewSuggestionRevisionAuthor,
    createdAt: UtcTimestamp
  }).check(
    Schema.makeFilter(
      ({ predecessorRevisionId, sequence }) => (sequence === 1) === (predecessorRevisionId === null),
      {
        expected: "only original sequence one to omit a predecessor revision"
      }
    ),
    Schema.makeFilter(
      ({ subject, suggestion, validation }) =>
        validation.reviewedHead === subject.headRevision &&
        (suggestion.replacement === undefined ||
          suggestion.replacement.reviewedHead === subject.headRevision),
      {
        expected: "revision validation and replacement bound to the exact reviewed head"
      }
    )
  )
) {}

/** Cursor-bounded immutable revision history, newest first. */
export const PrReviewSuggestionRevisionPage = Schema.Struct({
  current: PrReviewSuggestionRevision,
  revisions: Schema.Array(PrReviewSuggestionRevision).check(
    Schema.isMaxLength(MAXIMUM_PR_REVIEW_SUGGESTION_REVISION_PAGE_SIZE)
  ),
  hasMore: Schema.Boolean,
  nextBeforeSequence: Schema.NullOr(PrReviewSuggestionRevisionSequence)
})

/** Decoded cursor-bounded suggestion revision page. */
export type PrReviewSuggestionRevisionPage = typeof PrReviewSuggestionRevisionPage.Type

const PrReviewTechnicalClaim = Schema.Struct({
  severity: PrReviewSuggestion.fields.severity,
  problem: PrReviewSuggestion.fields.problem,
  impact: PrReviewSuggestion.fields.impact,
  evidence: PrReviewSuggestion.fields.evidence,
  recommendation: PrReviewSuggestion.fields.recommendation,
  confidence: PrReviewSuggestion.fields.confidence,
  relatedLocations: PrReviewSuggestion.fields.relatedLocations,
  prevention: PrReviewSuggestion.fields.prevention,
  replacement: PrReviewSuggestion.fields.replacement,
  anchor: PrReviewSuggestion.fields.anchor
})

const encodeTechnicalClaim = Schema.encodeSync(PrReviewTechnicalClaim)

/** Compare only content whose change invalidates prior technical evidence. */
export const hasSamePrReviewTechnicalClaim = (
  left: PrReviewSuggestionEdit,
  right: PrReviewSuggestionEdit
): boolean =>
  JSON.stringify(encodeTechnicalClaim(left)) ===
    JSON.stringify(encodeTechnicalClaim(right))
