/**
 * The three inputs and every way a run can fail.
 *
 * `guide.json` is Plannotator's shape, unchanged, so the same file still feeds
 * `plannotator guide export`. `findings.json` is ours: the Secure Coding Review
 * checklist and the P1–P4 Issues a review wrote, each Issue pointing at a file and,
 * when the review gave one, a line. The patch is a plain `git diff`.
 */
import * as Schema from "effect/Schema"

/** One attributable run; missing counters are unknown, never zero. */
const Count = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))
export const Usage = Schema.Struct({
  label: Schema.NonEmptyString,
  scope: Schema.Literals(["implementation", "review", "guide"]),
  source: Schema.NonEmptyString,
  model: Schema.optionalKey(Schema.String),
  inputTokens: Schema.optionalKey(Count),
  outputTokens: Schema.optionalKey(Count),
  cachedInputTokens: Schema.optionalKey(Count),
  durationMs: Schema.optionalKey(Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0))),
  cost: Schema.optionalKey(Schema.Struct({
    amount: Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0)),
    currency: Schema.String.check(Schema.isPattern(/^[A-Z]{3}$/)),
    basis: Schema.Literals(["reported", "estimated"])
  }))
})
export type Usage = typeof Usage.Type

// ── guide.json ────────────────────────────────────────────────────────────────

export const GuideDiff = Schema.Struct({
  /** Exact path as it appears in the patch. */
  file: Schema.String,
  summary: Schema.String
})

export const GuideSection = Schema.Struct({
  title: Schema.String,
  /** Markdown: paragraphs, `###`, bullets, callouts, fenced code (mermaid included). */
  overview: Schema.String,
  diffs: Schema.Array(GuideDiff)
})
export type GuideSection = typeof GuideSection.Type

export const Guide = Schema.Struct({
  usage: Schema.optionalKey(Schema.Array(Usage)),
  title: Schema.String,
  intent: Schema.String,
  sections: Schema.Array(GuideSection),
  unplacedFiles: Schema.Array(Schema.String),
  review: Schema.Struct({
    gitRef: Schema.String,
    base: Schema.optionalKey(Schema.String)
  }),
  source: Schema.optionalKey(
    Schema.Struct({
      pr: Schema.optionalKey(
        Schema.Struct({
          url: Schema.String.check(Schema.isPattern(/^https?:\/\/[^\s]+$/)),
          number: Schema.optionalKey(Schema.Union([Schema.Number, Schema.String])),
          title: Schema.optionalKey(Schema.String)
        })
      )
    })
  ),
  generator: Schema.optionalKey(
    Schema.Struct({
      engine: Schema.optionalKey(Schema.String),
      model: Schema.optionalKey(Schema.String)
    })
  )
})
export type Guide = typeof Guide.Type

// ── findings.json ─────────────────────────────────────────────────────────────

export const Severity = Schema.Literals(["P1", "P2", "P3", "P4"])
export type Severity = typeof Severity.Type

export const Verdict = Schema.Literals(["Yes", "No", "N/A"])

export const ChecklistItem = Schema.Struct({
  item: Schema.String,
  verdict: Verdict,
  note: Schema.optionalKey(Schema.String)
})
export type ChecklistItem = typeof ChecklistItem.Type

export const Issue = Schema.Struct({
  /** The review's own number, so "Issue 2" here is "Issue 2" in the document. */
  id: Schema.Number,
  severity: Severity,
  /** Exact path as it appears in the patch. */
  file: Schema.String,
  /** Line in the file; `side` says which version of it. Absent means the whole file. */
  line: Schema.optionalKey(Schema.Number),
  /** Default `new`: the line number counts in the changed file. */
  side: Schema.optionalKey(Schema.Literals(["new", "old"])),
  summary: Schema.String,
  recommendation: Schema.optionalKey(Schema.String),
  /** Existing review evidence: trigger, path through the code, and consequence. */
  explanation: Schema.optionalKey(Schema.String),
  /** Set when the author acknowledged or resolved the Issue; shown in place of the fix. */
  status: Schema.optionalKey(Schema.String)
})
export type Issue = typeof Issue.Type

export const Findings = Schema.Struct({
  /** Where the findings came from, shown in the verdict header. */
  source: Schema.optionalKey(Schema.String),
  checklist: Schema.Array(ChecklistItem),
  issues: Schema.Array(Issue),
  preExisting: Schema.optionalKey(Schema.Array(Schema.String)),
  openQuestions: Schema.optionalKey(Schema.Array(Schema.String))
})
export type Findings = typeof Findings.Type

export const emptyFindings: Findings = { checklist: [], issues: [] }
