/** Provider-neutral, bounded review readings. No command or provider credential authority. @module */
import { Schema } from "effect"
import { ReviewExecutionProfile, ReviewKind, ReviewSeverity, ReviewThreadIdentity } from "./model.js"

export { ReviewSeverity, reviewSeverityOrder } from "./model.js"

const Id = Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(256))
const Text = Schema.String.check(Schema.isMaxLength(16_384))
const Path = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(1_024))
// All reading times must fit the Date/Intl formatting boundary used by the read views.
const Timestamp = Schema.Number.check(
  Schema.isFinite(),
  Schema.isBetween({ minimum: 0, maximum: 8_640_000_000_000_000 })
)

export const ReviewAxis = Schema.Literals(["Standards", "Spec", "Security"])

export const ReviewAnchor = Schema.Union([
  Schema.TaggedStruct("Unanchored", {}),
  Schema.TaggedStruct("File", { path: Path, outdated: Schema.Boolean }),
  Schema.TaggedStruct("Line", {
    path: Path,
    line: Schema.Int.check(Schema.isGreaterThan(0)),
    side: Schema.Literals(["before", "after"]),
    outdated: Schema.Boolean
  })
])
export type ReviewAnchor = typeof ReviewAnchor.Type

/** A suggestion belongs to one file at one immutable reviewed head. It is never an executed fix. */
export const ReviewPatch = Schema.Struct({ path: Path, headRevision: Id, text: Text })
export const ReviewDisposition = Schema.Union([
  Schema.TaggedStruct("Open", {}),
  Schema.TaggedStruct("FixedVerify", { commit: Id }),
  Schema.TaggedStruct("Resolved", {}),
  Schema.TaggedStruct("Dismissed", {
    reason: Schema.Literals(["false_positive", "wont_fix", "already_fixed", "other"]),
    note: Schema.NullOr(Text)
  })
])
export type ReviewDisposition = typeof ReviewDisposition.Type

export const ReviewMessage = Schema.Struct({
  id: Id,
  author: Id,
  createdAt: Timestamp,
  text: Text,
  deleted: Schema.Boolean
})
export type ReviewMessage = typeof ReviewMessage.Type

export const ReviewFinding = Schema.Struct({
  severity: ReviewSeverity,
  axis: Schema.NullOr(ReviewAxis),
  confidence: Schema.NullOr(Schema.Literals(["high", "medium", "low"])),
  claim: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(500)),
  summary: Schema.NullOr(Text),
  why: Text,
  recommendation: Text,
  verification: Text,
  requirement: Schema.NullOr(Text),
  patch: Schema.NullOr(ReviewPatch),
  disposition: ReviewDisposition
})
export type ReviewFinding = typeof ReviewFinding.Type

/** Source/id is the stable normalized thread identity; author names are display data only. */
export const ReviewThread = Schema.Struct({
  id: Id,
  source: Schema.Literals(["agent", "codecommit", "slack"]),
  anchor: ReviewAnchor,
  resolved: Schema.Boolean,
  messages: Schema.Array(ReviewMessage).check(Schema.isMaxLength(100)),
  finding: Schema.NullOr(ReviewFinding)
}).check(Schema.makeFilter((thread) => {
  if ((thread.source === "agent") !== (thread.finding !== null)) return false
  const patch = thread.finding?.patch
  return patch === undefined || patch === null ||
    (thread.anchor._tag !== "Unanchored" && patch.path === thread.anchor.path)
}, { expected: "agent finding or human discussion, with a suggested patch anchored to its own file" }))
export type ReviewThread = typeof ReviewThread.Type

const Threads = Schema.Array(ReviewThread).check(
  Schema.isMaxLength(500),
  Schema.makeFilter(
    (threads) => new Set(threads.map((thread) => JSON.stringify([thread.source, thread.id]))).size === threads.length,
    { expected: "unique source/thread identities" }
  )
)

/** Completed output survives head movement; its original identity must remain attached. */
export const ReviewRun = Schema.Struct({
  id: Id,
  identity: ReviewThreadIdentity,
  profile: Schema.NullOr(ReviewExecutionProfile),
  kind: ReviewKind,
  completedAt: Timestamp,
  summary: Text,
  explanation: Schema.NullOr(Text),
  risks: Schema.NullOr(Schema.Array(Text).check(Schema.isMaxLength(50))),
  focus: Schema.NullOr(Text),
  rules: Schema.NullOr(Schema.Array(Path).check(Schema.isMaxLength(100))),
  threads: Threads
}).check(Schema.makeFilter((run) =>
  (run.profile === null || run.profile.kind === run.kind) &&
  (run.kind !== "explain" || (run.explanation !== null && run.threads.length === 0)) &&
  run.threads.every((thread) =>
    thread.finding?.patch === undefined || thread.finding.patch === null ||
    thread.finding.patch.headRevision === run.identity.headRevision
  ), { expected: "output matches its review kind and suggested patches belong to the immutable reviewed head" }))
export type ReviewRun = typeof ReviewRun.Type

export const ReviewHistoryFailureReason = Schema.Literals(["io", "invalid", "oversized", "private_path"])

/** Missing history differs from a refused or damaged record; neither is a clean verdict. */
export const ReviewRunReading = Schema.Union([
  Schema.TaggedStruct("NotRecorded", {}),
  Schema.TaggedStruct("Ready", { run: ReviewRun }),
  Schema.TaggedStruct("Unavailable", { reason: ReviewHistoryFailureReason })
])
export type ReviewRunReading = typeof ReviewRunReading.Type

export const ReviewChecks = Schema.Union([
  Schema.TaggedStruct("Unknown", {}),
  Schema.TaggedStruct("Ready", {
    observedAt: Timestamp,
    items: Schema.Array(Schema.Struct({
      id: Id,
      name: Id,
      state: Schema.Literals(["queued", "running", "passed", "failed", "cancelled", "skipped"]),
      logHref: Schema.NullOr(Schema.String.check(Schema.isPattern(/^https?:\/\/[^\s]+$/u)))
    })).check(Schema.isMaxLength(100))
  })
])

/** Missing integrations and missing runs are unknown, never empty success or a clean verdict. */
export const ReviewConversations = Schema.Union([
  Schema.TaggedStruct("Unavailable", { reason: Schema.Literals(["not_cached", "over_limit", "corrupt"]) }),
  Schema.TaggedStruct("Ready", { observedAt: Timestamp, threads: Threads })
])
export type ReviewConversations = typeof ReviewConversations.Type

/** Missing integrations and missing runs are unknown, never empty success or a clean verdict. */
export const ReviewWorkspace = Schema.Struct({
  identity: ReviewThreadIdentity,
  observedAt: Timestamp,
  run: ReviewRunReading,
  conversations: ReviewConversations,
  checks: ReviewChecks
}).check(Schema.makeFilter((workspace) =>
  workspace.run._tag !== "Ready" ||
  (workspace.run.run.identity.namespace === workspace.identity.namespace &&
    workspace.run.run.identity.subjectId === workspace.identity.subjectId), {
  expected: "retained review output belongs to the same PR"
}))
export type ReviewWorkspace = typeof ReviewWorkspace.Type
