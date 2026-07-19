import * as Result from "effect/Result"
import * as Schema from "effect/Schema"

import { SourceUrl } from "./sourceRevision.js"

const boundedText = (maximum: number, identifier: string) =>
  Schema.String.check(Schema.isMaxLength(maximum)).annotate({ identifier })

const boundedNonEmptyText = (maximum: number, identifier: string) =>
  boundedText(maximum, identifier).check(Schema.isTrimmed(), Schema.isNonEmpty())

const boundedArray = <T, E, RD, RE>(schema: Schema.Codec<T, E, RD, RE>, maximum: number) =>
  Schema.Array(schema).check(Schema.isMaxLength(maximum))

export const MAXIMUM_NORMALIZED_ISSUE_LABELS = 200
export const MAXIMUM_NORMALIZED_ISSUE_COMPONENTS = 100
// One issue, its activity evidence, 200 people, and three events per fix version must fit one 500-event page.
export const MAXIMUM_NORMALIZED_ISSUE_FIX_VERSIONS = 99
export const MAXIMUM_NORMALIZED_ISSUE_SUBTASKS = 200
export const MAXIMUM_NORMALIZED_ISSUE_COLLABORATORS = 200
export const MAXIMUM_NORMALIZED_ISSUE_COMMENTS = 200
export const MAXIMUM_NORMALIZED_ISSUE_HISTORY = 200
export const MAXIMUM_NORMALIZED_ISSUE_HISTORY_CHANGES = 100

const SourceObjectId = boundedNonEmptyText(512, "NormalizedIssueSourceObjectId")
const SourcePersonId = boundedNonEmptyText(512, "NormalizedIssueSourcePersonId")
const ShortText = boundedText(255, "NormalizedIssueShortText")
const RichText = boundedText(16_000, "NormalizedIssueRichText")
const TimestampText = boundedNonEmptyText(100, "NormalizedIssueTimestamp")
const AvatarUrl = boundedNonEmptyText(2_048, "NormalizedIssueAvatarUrl").check(
  Schema.makeFilter((value) => Result.isSuccess(Schema.decodeUnknownResult(SourceUrl)(value)), {
    expected: "an HTTP(S) source URL without embedded credentials"
  })
)

/** Provider-neutral named source object retained with a bounded source identity. */
export const NormalizedIssueNamedValue = Schema.Struct({
  sourceId: Schema.NullOr(SourceObjectId),
  name: Schema.NullOr(ShortText)
}).annotate({ identifier: "NormalizedIssueNamedValue" })

/** Provider-neutral project identity and presentation retained from an issue source. */
export const NormalizedIssueProject = Schema.Struct({
  sourceId: Schema.NullOr(SourceObjectId),
  key: Schema.NullOr(boundedNonEmptyText(100, "NormalizedIssueProjectKey")),
  name: Schema.NullOr(ShortText)
}).annotate({ identifier: "NormalizedIssueProject" })

/** Provider-neutral release/version reference retained from an issue source. */
export const NormalizedIssueFixVersion = Schema.Struct({
  sourceId: Schema.NullOr(SourceObjectId),
  name: Schema.NullOr(ShortText),
  released: Schema.Boolean,
  releaseDate: Schema.NullOr(TimestampText)
}).annotate({ identifier: "NormalizedIssueFixVersion" })

/** Provider-neutral parent or subtask reference retained from an issue source. */
export const NormalizedRelatedIssue = Schema.Struct({
  sourceId: Schema.NullOr(SourceObjectId),
  key: Schema.NullOr(boundedNonEmptyText(100, "NormalizedRelatedIssueKey")),
  summary: Schema.NullOr(boundedText(500, "NormalizedRelatedIssueSummary")),
  status: Schema.NullOr(NormalizedIssueNamedValue)
}).annotate({ identifier: "NormalizedRelatedIssue" })

/** Bounded source collaborator used for attribution without provider response types. */
export const NormalizedIssueCollaborator = Schema.Struct({
  sourcePersonId: SourcePersonId,
  displayName: boundedNonEmptyText(200, "NormalizedIssueCollaboratorDisplayName"),
  avatarUrl: Schema.NullOr(AvatarUrl),
  active: Schema.Boolean,
  roles: boundedArray(boundedNonEmptyText(100, "NormalizedIssueCollaboratorRole"), 16).check(Schema.isUnique())
}).annotate({ identifier: "NormalizedIssueCollaborator" })

/** Bounded provider-neutral issue comment. */
export const NormalizedIssueComment = Schema.Struct({
  sourceId: SourceObjectId,
  authorSourcePersonId: Schema.NullOr(SourcePersonId),
  updateAuthorSourcePersonId: Schema.NullOr(SourcePersonId),
  body: Schema.NullOr(RichText),
  createdAt: Schema.NullOr(TimestampText),
  updatedAt: Schema.NullOr(TimestampText)
}).annotate({ identifier: "NormalizedIssueComment" })

/** One bounded provider-neutral field transition. */
export const NormalizedIssueHistoryChange = Schema.Struct({
  field: boundedNonEmptyText(255, "NormalizedIssueHistoryField"),
  from: Schema.NullOr(boundedText(1_000, "NormalizedIssueHistoryValue")),
  to: Schema.NullOr(boundedText(1_000, "NormalizedIssueHistoryValue"))
}).annotate({ identifier: "NormalizedIssueHistoryChange" })

/** Bounded provider-neutral issue history entry. */
export const NormalizedIssueHistoryEntry = Schema.Struct({
  sourceId: SourceObjectId,
  authorSourcePersonId: Schema.NullOr(SourcePersonId),
  createdAt: Schema.NullOr(TimestampText),
  changes: boundedArray(NormalizedIssueHistoryChange, MAXIMUM_NORMALIZED_ISSUE_HISTORY_CHANGES)
}).annotate({ identifier: "NormalizedIssueHistoryEntry" })

/** Fields whose source material may be deliberately reduced to remain within synchronization bounds. */
export const NormalizedIssueTruncatedField = Schema.Literals([
  "acceptanceCriteria",
  "collaborators",
  "comments",
  "components",
  "description",
  "environment",
  "fixVersions",
  "history",
  "issueType",
  "key",
  "labels",
  "parent",
  "priority",
  "project",
  "resolution",
  "summary",
  "status",
  "subtasks",
  "updatedAt",
  "createdAt",
  "dueDate",
  "resolvedAt"
])

/**
 * Shared provider-neutral issue detail accepted from normalized plugins.
 *
 * The original compact key/status/priority/estimate fields remain required.
 * Rich fields are optional so older normalized plugins and persisted projections
 * remain valid; first-party Jira synchronization always supplies every rich field.
 */
export const NormalizedIssueAttributes = Schema.Struct({
  key: boundedNonEmptyText(100, "NormalizedIssueKey"),
  status: boundedNonEmptyText(100, "NormalizedIssueStatus"),
  priority: Schema.NullOr(boundedNonEmptyText(100, "NormalizedIssuePriority")),
  estimatePoints: Schema.NullOr(Schema.Number.check(Schema.isGreaterThanOrEqualTo(0))),
  summary: Schema.optionalKey(boundedText(500, "NormalizedIssueSummary")),
  description: Schema.optionalKey(Schema.NullOr(RichText)),
  acceptanceCriteria: Schema.optionalKey(Schema.NullOr(RichText)),
  environment: Schema.optionalKey(Schema.NullOr(RichText)),
  issueType: Schema.optionalKey(Schema.NullOr(NormalizedIssueNamedValue)),
  project: Schema.optionalKey(Schema.NullOr(NormalizedIssueProject)),
  resolution: Schema.optionalKey(Schema.NullOr(NormalizedIssueNamedValue)),
  labels: Schema.optionalKey(
    boundedArray(boundedNonEmptyText(255, "NormalizedIssueLabel"), MAXIMUM_NORMALIZED_ISSUE_LABELS)
  ),
  components: Schema.optionalKey(boundedArray(NormalizedIssueNamedValue, MAXIMUM_NORMALIZED_ISSUE_COMPONENTS)),
  fixVersions: Schema.optionalKey(boundedArray(NormalizedIssueFixVersion, MAXIMUM_NORMALIZED_ISSUE_FIX_VERSIONS)),
  createdAt: Schema.optionalKey(Schema.NullOr(TimestampText)),
  updatedAt: Schema.optionalKey(Schema.NullOr(TimestampText)),
  dueDate: Schema.optionalKey(Schema.NullOr(TimestampText)),
  resolvedAt: Schema.optionalKey(Schema.NullOr(TimestampText)),
  parent: Schema.optionalKey(Schema.NullOr(NormalizedRelatedIssue)),
  subtasks: Schema.optionalKey(boundedArray(NormalizedRelatedIssue, MAXIMUM_NORMALIZED_ISSUE_SUBTASKS)),
  assigneeSourcePersonId: Schema.optionalKey(Schema.NullOr(SourcePersonId)),
  reporterSourcePersonId: Schema.optionalKey(Schema.NullOr(SourcePersonId)),
  creatorSourcePersonId: Schema.optionalKey(Schema.NullOr(SourcePersonId)),
  collaborators: Schema.optionalKey(boundedArray(NormalizedIssueCollaborator, MAXIMUM_NORMALIZED_ISSUE_COLLABORATORS)),
  comments: Schema.optionalKey(boundedArray(NormalizedIssueComment, MAXIMUM_NORMALIZED_ISSUE_COMMENTS)),
  commentTotal: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  commentsTruncated: Schema.optionalKey(Schema.Boolean),
  history: Schema.optionalKey(boundedArray(NormalizedIssueHistoryEntry, MAXIMUM_NORMALIZED_ISSUE_HISTORY)),
  historyTotal: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  historyTruncated: Schema.optionalKey(Schema.Boolean),
  truncatedFields: Schema.optionalKey(boundedArray(NormalizedIssueTruncatedField, 32).check(Schema.isUnique()))
}).annotate({ identifier: "NormalizedIssueAttributes" })

/** Decoded provider-neutral normalized issue detail. */
export type NormalizedIssueAttributes = typeof NormalizedIssueAttributes.Type
