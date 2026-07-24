/** Bounded, provider-neutral pull-request review result contracts. @module */
import * as Schema from "effect/Schema"

/** Maximum number of findings retained in one durable review report. */
export const MAXIMUM_PR_REVIEW_FINDINGS = 12

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

/** Static or behavioral enforcement layer proposed by one finding. */
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

/** Stable model-authored identity within one review report. */
export const PrReviewFindingId = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u, {
    expected: "a domain-safe finding identifier"
  })
).pipe(Schema.brand("PrReviewFindingId"))

/** Decoded PR-review finding identity. */
export type PrReviewFindingId = typeof PrReviewFindingId.Type

const PrReviewLine = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }))

/** One bounded, file-specific finding awaiting stable diff-anchor resolution. */
export const PrReviewFinding = Schema.Struct({
  findingId: PrReviewFindingId,
  severity: Schema.Literals(["critical", "high", "medium", "low", "info"]),
  path: PrReviewPath,
  startLine: PrReviewLine,
  endLine: PrReviewLine,
  title: boundedSingleLine(500, "PrReviewFindingTitle"),
  detail: boundedMultiline(4_000, "PrReviewFindingDetail"),
  prevention: PrReviewPrevention
})
  .check(
    Schema.makeFilter(({ endLine, startLine }) => startLine <= endLine, {
      expected: "a finding end line at or after its start line"
    })
  )
  .annotate({ identifier: "PrReviewFinding" })

/** Decoded PR-review finding. */
export type PrReviewFinding = typeof PrReviewFinding.Type

/**
 * Model-authored recommendation vocabulary.
 *
 * These values intentionally cannot encode the human `approve` or
 * `request-changes` disposition.
 */
export const PrReviewAgentRecommendation = Schema.Literals([
  "no-material-findings",
  "changes-recommended",
  "unable-to-conclude"
])

/** Decoded model-authored PR recommendation. */
export type PrReviewAgentRecommendation = typeof PrReviewAgentRecommendation.Type

/** Separate human authority vocabulary, not accepted in an agent report. */
export const PrReviewHumanDisposition = Schema.Literals(["approve", "request-changes"])

/** Decoded human PR-review disposition. */
export type PrReviewHumanDisposition = typeof PrReviewHumanDisposition.Type

const hasMaximumReportBytes = Schema.makeFilter(
  (value: unknown) => {
    const serialized = JSON.stringify(value)
    return serialized !== undefined && jsonEncoder.encode(serialized).byteLength <= MAXIMUM_PR_REVIEW_REPORT_BYTES
  },
  { expected: `JSON encoded as at most ${MAXIMUM_PR_REVIEW_REPORT_BYTES} UTF-8 bytes` }
)

/** Complete sanitized result produced for one exact immutable PR subject. */
export const PrReviewReport = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  subject: PrReviewSubject,
  recommendation: PrReviewAgentRecommendation,
  summary: boundedMultiline(4_000, "PrReviewSummary"),
  findings: Schema.Array(PrReviewFinding).check(
    Schema.isMaxLength(MAXIMUM_PR_REVIEW_FINDINGS),
    Schema.makeFilter((findings) => new Set(findings.map(({ findingId }) => findingId)).size === findings.length, {
      expected: "unique PR review finding identifiers"
    })
  )
})
  .check(hasMaximumReportBytes)
  .annotate({ identifier: "PrReviewReport" })

/** Decoded complete PR-review report. */
export type PrReviewReport = typeof PrReviewReport.Type
