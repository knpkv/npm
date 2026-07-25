/** Evidence-anchored pull-request review suggestion contracts. @module */
import * as Schema from "effect/Schema"

/** Maximum UTF-8 JSON size retained inside the existing durable event envelope. */
export const MAXIMUM_PR_REVIEW_REPORT_BYTES = 32_768

const jsonEncoder = new TextEncoder()

const hasNoControlCharacters = (value: string): boolean =>
  Array.from(value).every((character) => {
    const codePoint = character.codePointAt(0)
    return (
      codePoint !== undefined && !((codePoint >= 0 && codePoint <= 0x1f) || (codePoint >= 0x7f && codePoint <= 0x9f))
    )
  })

const hasNoUnsafeMultilineControlCharacters = (value: string): boolean =>
  Array.from(value).every((character) => {
    const codePoint = character.codePointAt(0)
    return (
      codePoint !== undefined &&
      (codePoint === 0x09 ||
        codePoint === 0x0a ||
        codePoint === 0x0d ||
        !((codePoint >= 0 && codePoint <= 0x1f) || (codePoint >= 0x7f && codePoint <= 0x9f)))
    )
  })

const boundedSingleLine = (maximumLength: number, identifier: string) =>
  Schema.String.check(
    Schema.isTrimmed(),
    Schema.isNonEmpty(),
    Schema.isMaxLength(maximumLength),
    Schema.makeFilter(hasNoControlCharacters, { expected: "text without control characters" })
  ).annotate({ identifier })

const boundedMultiline = (maximumLength: number, identifier: string) =>
  Schema.String.check(
    Schema.isTrimmed(),
    Schema.isNonEmpty(),
    Schema.isMaxLength(maximumLength),
    Schema.makeFilter(hasNoUnsafeMultilineControlCharacters, {
      expected: "text without unsafe control characters"
    })
  ).annotate({ identifier })

const isSafeRepositoryPath = (value: string): boolean => {
  if (value.startsWith("/") || value.startsWith("\\") || /^[A-Za-z]:/u.test(value) || value.includes("\\")) return false
  const segments = value.split("/")
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..")
}

/** Normalized repository-relative path safe to compare with an immutable diff. */
export const PrReviewPath = boundedSingleLine(1_024, "PrReviewPath")
  .check(
    Schema.makeFilter(isSafeRepositoryPath, {
      expected: "a normalized repository-relative path without traversal"
    })
  )
  .pipe(Schema.brand("PrReviewPath"))

/** Decoded normalized PR-review path. */
export type PrReviewPath = typeof PrReviewPath.Type

/** Exact immutable pull request revision reviewed by an agent. */
export const PrReviewSubject = Schema.Struct({
  providerId: Schema.Literal("codecommit"),
  repository: boundedSingleLine(200, "PrReviewRepository"),
  pullRequestId: boundedSingleLine(512, "PrReviewPullRequestId"),
  baseRevision: boundedSingleLine(512, "PrReviewBaseRevision"),
  headRevision: boundedSingleLine(512, "PrReviewHeadRevision")
}).annotate({ identifier: "PrReviewSubject" })

/** Decoded immutable pull request review subject. */
export type PrReviewSubject = typeof PrReviewSubject.Type

/** Static or behavioral enforcement layer proposed by one suggestion. */
export const PrReviewPreventionEnforcement = Schema.Literals([
  "ast-grep",
  "ESLint",
  "type-check",
  "test",
  "instruction"
])

/** Decoded PR-review prevention enforcement layer. */
export type PrReviewPreventionEnforcement = typeof PrReviewPreventionEnforcement.Type

const PreventionProposal = Schema.Struct({
  summary: boundedSingleLine(500, "PrReviewPreventionSummary"),
  enforcement: PrReviewPreventionEnforcement,
  existingRuleOrConfig: boundedSingleLine(500, "PrReviewExistingRuleOrConfig"),
  targetFile: PrReviewPath,
  sourcePaths: Schema.Array(PrReviewPath).check(Schema.isMinLength(1), Schema.isMaxLength(32), Schema.isUnique()),
  matcherOrInvariant: boundedMultiline(4_000, "PrReviewPreventionMatcherOrInvariant"),
  invalidFixture: boundedMultiline(8_000, "PrReviewInvalidFixture"),
  validFixture: boundedMultiline(8_000, "PrReviewValidFixture"),
  boundary: boundedMultiline(4_000, "PrReviewPreventionBoundary")
}).check(
  Schema.makeFilter(({ invalidFixture, validFixture }) => invalidFixture !== validFixture, {
    expected: "distinct invalid and valid prevention fixtures"
  })
)

const NoPreventionProposal = Schema.Struct({
  summary: boundedSingleLine(500, "PrReviewPreventionSummary"),
  enforcement: Schema.Literal("none"),
  rationale: boundedMultiline(2_000, "PrReviewNoPreventionRationale")
})

/** Implementation-ready guardrail proposal, or a bounded explanation for omitting one. */
export const PrReviewPrevention = Schema.Union([PreventionProposal, NoPreventionProposal])

/** Decoded PR-review prevention note. */
export type PrReviewPrevention = typeof PrReviewPrevention.Type

/** Stable host-derived suggestion identity within one immutable review. */
export const PrReviewSuggestionId = Schema.String.check(
  Schema.isPattern(/^sha256:[a-f0-9]{64}$/u, {
    expected: "a sha256 suggestion identity"
  })
).pipe(Schema.brand("PrReviewSuggestionId"))

/** Decoded PR-review suggestion identity. */
export type PrReviewSuggestionId = typeof PrReviewSuggestionId.Type

const PrReviewLine = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }))

/** Exact source evidence which must be verified against an added diff line. */
export const PrReviewSuggestionEvidence = Schema.Struct({
  path: PrReviewPath,
  startLine: PrReviewLine,
  endLine: PrReviewLine,
  excerpt: Schema.String.check(
    Schema.isNonEmpty(),
    Schema.isMaxLength(8_000),
    Schema.makeFilter(hasNoUnsafeMultilineControlCharacters, {
      expected: "source evidence without unsafe control characters"
    })
  )
})
  .check(
    Schema.makeFilter(({ endLine, startLine }) => startLine <= endLine, {
      expected: "an evidence end line at or after its start line"
    })
  )
  .annotate({ identifier: "PrReviewSuggestionEvidence" })

/** Decoded PR-review suggestion evidence. */
export type PrReviewSuggestionEvidence = typeof PrReviewSuggestionEvidence.Type

/** Optional exact replacement for the evidence range. */
export const PrReviewReplacement = Schema.Struct({
  content: boundedMultiline(16_000, "PrReviewReplacementContent")
}).annotate({ identifier: "PrReviewReplacement" })

/** Decoded PR-review replacement. */
export type PrReviewReplacement = typeof PrReviewReplacement.Type

/** Confidence is explicit and always accompanied by model reasoning. */
export const PrReviewConfidence = Schema.Struct({
  level: Schema.Literals(["low", "medium", "high"]),
  reason: boundedMultiline(2_000, "PrReviewConfidenceReason")
}).annotate({ identifier: "PrReviewConfidence" })

/** Decoded PR-review confidence. */
export type PrReviewConfidence = typeof PrReviewConfidence.Type

const prReviewSuggestionDraftFields = {
  severity: Schema.Literals(["P1", "P2", "P3", "P4"]),
  problem: boundedMultiline(4_000, "PrReviewSuggestionProblem"),
  impact: boundedMultiline(4_000, "PrReviewSuggestionImpact"),
  evidence: PrReviewSuggestionEvidence,
  recommendation: boundedMultiline(8_000, "PrReviewSuggestionRecommendation"),
  confidence: PrReviewConfidence,
  prevention: Schema.optionalKey(PrReviewPrevention),
  replacement: Schema.optionalKey(PrReviewReplacement)
}

/** Model output for one suggestion before immutable identity is derived. */
export const PrReviewSuggestionDraft = Schema.Struct(
  prReviewSuggestionDraftFields
).annotate({ identifier: "PrReviewSuggestionDraft" })

/** Decoded model-authored suggestion awaiting evidence verification. */
export type PrReviewSuggestionDraft = typeof PrReviewSuggestionDraft.Type

/** One schema-valid and evidence-verified suggestion. */
export const PrReviewSuggestion = Schema.Struct({
  suggestionId: PrReviewSuggestionId,
  ...prReviewSuggestionDraftFields
}).annotate({ identifier: "PrReviewSuggestion" })

/** Decoded PR-review suggestion. */
export type PrReviewSuggestion = typeof PrReviewSuggestion.Type

/** Epistemic completion state; this is not an approval or overall model verdict. */
export const PrReviewCompletion = Schema.Union([
  Schema.Struct({ status: Schema.Literal("complete") }),
  Schema.Struct({
    status: Schema.Literal("unable-to-conclude"),
    reason: boundedMultiline(4_000, "PrReviewUnableToConcludeReason")
  })
]).annotate({ identifier: "PrReviewCompletion" })

/** Decoded review completion state. */
export type PrReviewCompletion = typeof PrReviewCompletion.Type

const hasMaximumReportBytes = Schema.makeFilter(
  (value: unknown) => {
    const serialized = JSON.stringify(value)
    return serialized !== undefined && jsonEncoder.encode(serialized).byteLength <= MAXIMUM_PR_REVIEW_REPORT_BYTES
  },
  { expected: `JSON encoded as at most ${MAXIMUM_PR_REVIEW_REPORT_BYTES} UTF-8 bytes` }
)

/**
 * Complete sanitized result for one immutable PR subject.
 *
 * Suggestions have no count cap. The durable event byte envelope remains the
 * only aggregate storage bound.
 */
export const PrReviewReport = Schema.Struct({
  schemaVersion: Schema.Literal(2),
  subject: PrReviewSubject,
  completion: PrReviewCompletion,
  suggestions: Schema.Array(PrReviewSuggestion).check(
    Schema.makeFilter(
      (suggestions) => new Set(suggestions.map(({ suggestionId }) => suggestionId)).size === suggestions.length,
      { expected: "unique PR review suggestion identifiers" }
    )
  )
})
  .check(hasMaximumReportBytes)
  .annotate({ identifier: "PrReviewReport" })

/** Decoded complete PR-review report. */
export type PrReviewReport = typeof PrReviewReport.Type

/** Outcome derived by Control Center, never authored by the model. */
export const PrReviewOutcome = Schema.Literals([
  "changes-required",
  "non-blocking-suggestions",
  "no-issues-found",
  "unable-to-conclude"
])

/** Decoded derived PR-review outcome. */
export type PrReviewOutcome = typeof PrReviewOutcome.Type

/** Derive the browser verdict from validated durable suggestions. */
export const derivePrReviewOutcome = (report: PrReviewReport): PrReviewOutcome => {
  if (report.completion.status === "unable-to-conclude") return "unable-to-conclude"
  if (report.suggestions.some(({ severity }) => severity === "P1" || severity === "P2")) {
    return "changes-required"
  }
  return report.suggestions.length > 0 ? "non-blocking-suggestions" : "no-issues-found"
}
