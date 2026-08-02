/** Evidence-anchored pull-request review suggestion contracts. @module */
import * as Effect from "effect/Effect"
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
  recurrenceEvidence: boundedMultiline(2_000, "PrReviewPreventionRecurrenceEvidence"),
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

/** Current durable presentation state; lifecycle transitions remain host-owned. */
export const PrReviewSuggestionState = Schema.Literals([
  "draft",
  "published",
  "stale",
  "resolved",
  "dismissed",
  "reopened"
])

/** Decoded suggestion presentation state. */
export type PrReviewSuggestionState = typeof PrReviewSuggestionState.Type

/** Human-selected reason a suggestion was dismissed. */
export const PrReviewDismissalReason = Schema.Literals([
  "false-positive",
  "not-applicable",
  "accepted-risk",
  "duplicate",
  "other"
])

/** Decoded dismissal reason retained with the immutable suggestion history. */
export type PrReviewDismissalReason = typeof PrReviewDismissalReason.Type

const PrReviewLine = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }))

const PrReviewLocation = Schema.Struct({
  path: PrReviewPath,
  startLine: PrReviewLine,
  endLine: PrReviewLine
}).check(
  Schema.makeFilter(({ endLine, startLine }) => startLine <= endLine, {
    expected: "a location end line at or after its start line"
  })
)

/** Exact source evidence which must be verified against an added diff line. */
export const PrReviewSuggestionEvidence = Schema.Struct({
  ...PrReviewLocation.fields,
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

/** Model-authored anchor before the host resolves file-level positions. */
export const PrReviewSuggestionDraftAnchor = Schema.Union([
  Schema.Struct({
    _tag: Schema.Literal("line"),
    path: PrReviewPath,
    line: PrReviewLine
  }),
  Schema.Struct({
    _tag: Schema.Literal("file"),
    path: PrReviewPath
  }),
  Schema.Struct({
    _tag: Schema.Literal("changes")
  })
]).annotate({ identifier: "PrReviewSuggestionDraftAnchor" })

/** Decoded unresolved model-authored suggestion anchor. */
export type PrReviewSuggestionDraftAnchor = typeof PrReviewSuggestionDraftAnchor.Type

/** Host-resolved primary anchor for line, file, or whole-change advice. */
const PrReviewAfterRelativeFileVersion = Schema.Literal("AFTER").pipe(
  Schema.withDecodingDefaultTypeKey(Effect.succeed("AFTER"))
)
const PrReviewRelativeFileVersion = Schema.Literals(["BEFORE", "AFTER"]).pipe(
  Schema.withDecodingDefaultTypeKey(Effect.succeed("AFTER"))
)

export const PrReviewSuggestionAnchor = Schema.Union([
  Schema.Struct({
    _tag: Schema.Literal("line"),
    path: PrReviewPath,
    line: PrReviewLine,
    relativeFileVersion: PrReviewAfterRelativeFileVersion
  }),
  Schema.Struct({
    _tag: Schema.Literal("file"),
    path: PrReviewPath,
    line: PrReviewLine,
    relativeFileVersion: PrReviewRelativeFileVersion
  }),
  Schema.Struct({
    _tag: Schema.Literal("changes")
  })
]).annotate({ identifier: "PrReviewSuggestionAnchor" })

/** Decoded host-resolved suggestion anchor. */
export type PrReviewSuggestionAnchor = typeof PrReviewSuggestionAnchor.Type

/** Secondary code location grouped under one root-cause suggestion. */
export const PrReviewRelatedLocation = Schema.Struct({
  ...PrReviewLocation.fields,
  label: boundedSingleLine(500, "PrReviewRelatedLocationLabel")
})
  .check(
    Schema.makeFilter(({ endLine, startLine }) => startLine <= endLine, {
      expected: "a related-location end line at or after its start line"
    })
  )
  .annotate({ identifier: "PrReviewRelatedLocation" })

/** Decoded related suggestion location. */
export type PrReviewRelatedLocation = typeof PrReviewRelatedLocation.Type

const isUnifiedDiff = (value: string): boolean => {
  const lines = value.split("\n")
  return (
    lines.some((line) => line.startsWith("--- ")) &&
    lines.some((line) => line.startsWith("+++ ")) &&
    lines.some((line) => line.startsWith("@@ "))
  )
}

/** Optional inert unified-diff replacement for the exact reviewed head. */
export const PrReviewReplacement = Schema.Struct({
  reviewedHead: boundedSingleLine(512, "PrReviewReplacementReviewedHead"),
  unifiedDiff: boundedMultiline(16_000, "PrReviewReplacementUnifiedDiff").check(
    Schema.makeFilter(isUnifiedDiff, { expected: "a unified diff with file headers and at least one hunk" })
  ),
  explanation: boundedMultiline(2_000, "PrReviewReplacementExplanation")
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
  title: boundedSingleLine(500, "PrReviewSuggestionTitle"),
  severity: Schema.Literals(["P1", "P2", "P3", "P4"]),
  problem: boundedMultiline(4_000, "PrReviewSuggestionProblem"),
  impact: boundedMultiline(4_000, "PrReviewSuggestionImpact"),
  evidence: PrReviewSuggestionEvidence,
  recommendation: boundedMultiline(8_000, "PrReviewSuggestionRecommendation"),
  confidence: PrReviewConfidence,
  relatedLocations: Schema.Array(PrReviewRelatedLocation).check(
    Schema.isMaxLength(32),
    Schema.makeFilter(
      (locations) =>
        new Set(locations.map(({ endLine, path, startLine }) => `${path}:${String(startLine)}:${String(endLine)}`))
          .size === locations.length,
      { expected: "unique related suggestion locations" }
    )
  ),
  prevention: Schema.optionalKey(PrReviewPrevention),
  replacement: Schema.optionalKey(PrReviewReplacement)
}

/** Model output for one suggestion before immutable identity is derived. */
export const PrReviewSuggestionDraft = Schema.Struct({
  ...prReviewSuggestionDraftFields,
  anchor: PrReviewSuggestionDraftAnchor
})
  .check(
    Schema.makeFilter(
      ({ anchor, confidence, evidence }) =>
        confidence.level !== "low" &&
        (anchor._tag === "changes" ||
          (anchor.path === evidence.path &&
            (anchor._tag === "file" || anchor.line === evidence.startLine))),
      { expected: "a medium/high-confidence suggestion whose file or line anchor matches its exact evidence" }
    ),
    Schema.makeFilter(
      ({ prevention, severity }) =>
        prevention === undefined ||
        prevention.enforcement === "none" ||
        severity === "P1" ||
        severity === "P2",
      { expected: "prevention proposals only for high-impact P1 or P2 defect classes" }
    )
  )
  .annotate({ identifier: "PrReviewSuggestionDraft" })

/** Decoded model-authored suggestion awaiting evidence verification. */
export type PrReviewSuggestionDraft = typeof PrReviewSuggestionDraft.Type

/** One schema-valid and evidence-verified suggestion. */
export const PrReviewSuggestion = Schema.Struct({
  suggestionId: PrReviewSuggestionId,
  state: PrReviewSuggestionState,
  dismissalReason: Schema.optionalKey(PrReviewDismissalReason),
  ...prReviewSuggestionDraftFields,
  anchor: PrReviewSuggestionAnchor
})
  .check(
    Schema.makeFilter(
      ({ anchor, confidence, evidence }) =>
        confidence.level !== "low" &&
        (anchor._tag === "changes" ||
          (anchor.path === evidence.path &&
            (anchor._tag === "file" || anchor.line === evidence.startLine))),
      { expected: "a medium/high-confidence suggestion whose file or line anchor matches its exact evidence" }
    ),
    Schema.makeFilter(
      ({ prevention, severity }) =>
        prevention === undefined ||
        prevention.enforcement === "none" ||
        severity === "P1" ||
        severity === "P2",
      { expected: "prevention proposals only for high-impact P1 or P2 defect classes" }
    )
  )
  .annotate({ identifier: "PrReviewSuggestion" })

/** Decoded PR-review suggestion. */
export type PrReviewSuggestion = typeof PrReviewSuggestion.Type

/**
 * Canonical identity material for one suggestion across immutable review heads.
 *
 * Coordinates that move when a patch is edited (head revision, anchors, and
 * line numbers) deliberately stay out of this material. The pull-request
 * identity and the technical claim are the stable seam used by reconciliation.
 */
export const prReviewSuggestionIdentityMaterial = (
  subject: PrReviewSubject,
  suggestion: Pick<PrReviewSuggestionDraft, "title" | "problem" | "recommendation" | "evidence">
): string =>
  JSON.stringify([
    subject.providerId,
    subject.repository,
    subject.pullRequestId,
    suggestion.title,
    suggestion.evidence.path,
    suggestion.evidence.excerpt,
    suggestion.problem,
    suggestion.recommendation
  ])

/** Stable host-derived identity for a non-publishable review note. */
export const PrReviewNoteId = Schema.String.check(
  Schema.isPattern(/^sha256:[a-f0-9]{64}$/u, {
    expected: "a sha256 review-note identity"
  })
).pipe(Schema.brand("PrReviewNoteId"))

/** Decoded review-note identity. */
export type PrReviewNoteId = typeof PrReviewNoteId.Type

const prReviewNoteDraftFields = {
  reason: Schema.Literals(["low-confidence", "pre-existing"]),
  title: boundedSingleLine(500, "PrReviewNoteTitle"),
  observation: boundedMultiline(4_000, "PrReviewNoteObservation"),
  confidence: PrReviewConfidence,
  location: Schema.optionalKey(PrReviewLocation)
}

/** Model output for a concern that must not be published. */
export const PrReviewNoteDraft = Schema.Struct(prReviewNoteDraftFields)
  .check(
    Schema.makeFilter(
      ({ confidence, reason }) => reason !== "low-confidence" || confidence.level === "low",
      { expected: "a low-confidence note with explicitly low confidence" }
    )
  )
  .annotate({ identifier: "PrReviewNoteDraft" })

/** Decoded model-authored review note awaiting host identity. */
export type PrReviewNoteDraft = typeof PrReviewNoteDraft.Type

/** Durable non-publishable concern separated from Review Suggestions. */
export const PrReviewNote = Schema.Struct({
  noteId: PrReviewNoteId,
  ...prReviewNoteDraftFields
})
  .check(
    Schema.makeFilter(
      ({ confidence, reason }) => reason !== "low-confidence" || confidence.level === "low",
      { expected: "a low-confidence note with explicitly low confidence" }
    )
  )
  .annotate({ identifier: "PrReviewNote" })

/** Decoded durable review note. */
export type PrReviewNote = typeof PrReviewNote.Type

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
    if (serialized === undefined) return false
    const maximumLifecycleProjection = serialized.replace(
      /"state":"(?:draft|stale|resolved|reopened)"/gu,
      "\"state\":\"published\""
    )
    return jsonEncoder.encode(maximumLifecycleProjection).byteLength <= MAXIMUM_PR_REVIEW_REPORT_BYTES
  },
  {
    expected:
      `JSON encoded as at most ${MAXIMUM_PR_REVIEW_REPORT_BYTES} UTF-8 bytes after the longest lifecycle projection`
  }
)

/**
 * Complete sanitized result for one immutable PR subject.
 *
 * Suggestions have no count cap. The durable event byte envelope remains the
 * only aggregate storage bound.
 */
export const PrReviewReport = Schema.Struct({
  schemaVersion: Schema.Literal(3),
  subject: PrReviewSubject,
  completion: PrReviewCompletion,
  suggestions: Schema.Array(PrReviewSuggestion).check(
    Schema.makeFilter(
      (suggestions) => new Set(suggestions.map(({ suggestionId }) => suggestionId)).size === suggestions.length,
      { expected: "unique PR review suggestion identifiers" }
    )
  ),
  notes: Schema.Array(PrReviewNote).check(
    Schema.makeFilter(
      (notes) => new Set(notes.map(({ noteId }) => noteId)).size === notes.length,
      { expected: "unique PR review note identifiers" }
    )
  )
})
  .check(
    Schema.makeFilter(
      ({ subject, suggestions }) =>
        suggestions.every(
          ({ replacement }) => replacement === undefined || replacement.reviewedHead === subject.headRevision
        ),
      { expected: "replacement patches bound to the exact reviewed head" }
    )
  )
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
  const openSuggestions = report.suggestions.filter(
    ({ state }) => state === "draft" || state === "published" || state === "reopened"
  )
  if (openSuggestions.some(({ severity }) => severity === "P1" || severity === "P2")) {
    return "changes-required"
  }
  return openSuggestions.length > 0 ? "non-blocking-suggestions" : "no-issues-found"
}
