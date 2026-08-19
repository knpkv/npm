import { assert, describe, it } from "@effect/vitest"
import { Result, Schema } from "effect"

import { JobId, PersonId, PrReviewSuggestionRevisionId } from "../../src/domain/identifiers.js"
import { PrReviewPath, PrReviewSubject, PrReviewSuggestion } from "../../src/domain/prReview.js"
import {
  hasSamePrReviewTechnicalClaim,
  PrReviewSuggestionEdit,
  PrReviewSuggestionOperatorAuthor,
  PrReviewSuggestionRequiresRevalidation,
  PrReviewSuggestionRevision,
  PrReviewSuggestionRevisionSequence,
  PrReviewSuggestionValidated
} from "../../src/domain/prReviewRevision.js"
import { UtcTimestamp } from "../../src/domain/utcTimestamp.js"

const jobId = JobId.make("019f795b-3204-7952-9fe1-3e769149202f")
const personId = PersonId.make("019f795b-3206-7233-beda-e3274e69cc66")
const revisionId = PrReviewSuggestionRevisionId.make(
  `sha256:${"a".repeat(64)}`
)
const subject = Schema.decodeUnknownSync(PrReviewSubject)({
  providerId: "codecommit",
  repository: "control-center",
  pullRequestId: "279",
  baseRevision: "1".repeat(40),
  headRevision: "2".repeat(40)
})
const suggestion = Schema.decodeUnknownSync(PrReviewSuggestion)({
  suggestionId: `sha256:${"1".repeat(64)}`,
  state: "draft",
  title: "Decode before persistence",
  severity: "P2",
  problem: "Untrusted agent output may reach durable state.",
  impact: "Malformed evidence could be published.",
  evidence: {
    path: "src/review.ts",
    startLine: 12,
    endLine: 12,
    excerpt: "const report = output"
  },
  recommendation: "Decode the complete report with Effect Schema.",
  confidence: {
    level: "high",
    reason: "The assignment is visible at the persistence boundary."
  },
  relatedLocations: [],
  anchor: {
    _tag: "line",
    path: "src/review.ts",
    line: 12,
    relativeFileVersion: "AFTER"
  }
})
const edit = Schema.decodeUnknownSync(PrReviewSuggestionEdit)(suggestion)

describe("PR review suggestion revisions", () => {
  it("uses constructors for explicit author and validation variants", () => {
    const author = PrReviewSuggestionOperatorAuthor.make({ personId })
    const validation = PrReviewSuggestionValidated.make({
      reviewedHead: subject.headRevision,
      validatingJobId: jobId,
      sourceRevisionId: revisionId
    })

    assert.strictEqual(author._tag, "operator")
    assert.strictEqual(validation._tag, "validated")
  })

  it("accepts a coherent immutable original revision", () => {
    const revision = PrReviewSuggestionRevision.make({
      revisionId,
      sequence: PrReviewSuggestionRevisionSequence.make(1),
      predecessorRevisionId: null,
      sourceJobId: jobId,
      subject,
      suggestion,
      validation: PrReviewSuggestionValidated.make({
        reviewedHead: subject.headRevision,
        validatingJobId: jobId,
        sourceRevisionId: revisionId
      }),
      author: PrReviewSuggestionOperatorAuthor.make({ personId }),
      createdAt: Schema.decodeUnknownSync(UtcTimestamp)(
        "2026-07-26T18:00:00.000Z"
      )
    })

    assert.strictEqual(revision.sequence, 1)
    assert.isNull(revision.predecessorRevisionId)
  })

  it("rejects invalid revision identity and sequence shapes", () => {
    assert.isTrue(
      Result.isFailure(
        Schema.decodeUnknownResult(PrReviewSuggestionRevisionId)("revision-1")
      )
    )
    assert.isTrue(
      Result.isFailure(
        Schema.decodeUnknownResult(PrReviewSuggestionRevisionSequence)(0)
      )
    )
    assert.isTrue(
      Result.isFailure(
        Schema.decodeUnknownResult(PrReviewSuggestionRevision)({
          revisionId,
          sequence: 2,
          predecessorRevisionId: null,
          sourceJobId: jobId,
          subject,
          suggestion,
          validation: PrReviewSuggestionValidated.make({
            reviewedHead: subject.headRevision,
            validatingJobId: jobId,
            sourceRevisionId: revisionId
          }),
          author: PrReviewSuggestionOperatorAuthor.make({ personId }),
          createdAt: "2026-07-26T18:00:00.000Z"
        })
      )
    )
  })

  it("retains validation for title-only edits", () => {
    const renamed = Schema.decodeUnknownSync(PrReviewSuggestionEdit)({
      ...edit,
      title: "Decode every model result before persistence"
    })

    assert.isTrue(hasSamePrReviewTechnicalClaim(edit, renamed))
  })

  it("invalidates validation for every technical claim field", () => {
    const variants: ReadonlyArray<PrReviewSuggestionEdit> = [
      { ...edit, severity: "P1" },
      { ...edit, problem: "A changed problem statement." },
      { ...edit, impact: "A changed impact statement." },
      {
        ...edit,
        evidence: { ...edit.evidence, excerpt: "const report = decode(output)" }
      },
      { ...edit, recommendation: "Use a different decoding boundary." },
      {
        ...edit,
        confidence: { ...edit.confidence, reason: "Different confidence evidence." }
      },
      {
        ...edit,
        relatedLocations: [{
          path: PrReviewPath.make("src/worker.ts"),
          startLine: 20,
          endLine: 20,
          label: "Same assignment"
        }]
      },
      {
        ...edit,
        prevention: {
          summary: "Require decoded review output.",
          enforcement: "test",
          existingRuleOrConfig: "PR review domain suite",
          recurrenceEvidence: "Agent outputs cross this boundary repeatedly.",
          targetFile: PrReviewPath.make(
            "packages/control-center/test/domain/prReviewRevision.test.ts"
          ),
          sourcePaths: [PrReviewPath.make("src/review.ts")],
          matcherOrInvariant: "Malformed output cannot become a suggestion revision.",
          invalidFixture: "persist(output)",
          validFixture: "persist(decode(output))",
          boundary: "Only the durable suggestion revision boundary is covered."
        }
      },
      {
        ...edit,
        replacement: {
          reviewedHead: subject.headRevision,
          unifiedDiff: [
            "--- a/src/review.ts",
            "+++ b/src/review.ts",
            "@@ -12,1 +12,1 @@",
            "-const report = output",
            "+const report = decode(output)"
          ].join("\n"),
          explanation: "Decode before assigning the report."
        }
      },
      {
        ...edit,
        anchor: { _tag: "changes" }
      }
    ]

    for (const variant of variants) {
      assert.isFalse(hasSamePrReviewTechnicalClaim(edit, variant))
    }
  })

  it("models revalidation as a new explicit state instead of mutating validation", () => {
    const validation = PrReviewSuggestionRequiresRevalidation.make({
      reviewedHead: subject.headRevision,
      sourceRevisionId: revisionId,
      reason: "technical-claim-edited"
    })

    assert.strictEqual(validation._tag, "requires-revalidation")
    assert.strictEqual(validation.reason, "technical-claim-edited")
  })
})
