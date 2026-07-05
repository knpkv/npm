/**
 * Core domain types for Jira Markdown Sync local workspace state.
 *
 * @internal
 */

export const FIELD_SHAPES = [
  "text",
  "multilineText",
  "number",
  "boolean",
  "date",
  "singleSelect",
  "multiSelect",
  "user",
  "cascadingSelect"
] as const

export type FieldShape = typeof FIELD_SHAPES[number]

export interface RequestedCustomField {
  readonly displayName: string
  readonly fieldId?: string | undefined
  readonly shape: FieldShape
  readonly ordered?: boolean | undefined
}

export interface WorkspaceConfig {
  readonly version: 1
  readonly siteUrl: string
  readonly documentsDir: string
  readonly customFields: ReadonlyArray<RequestedCustomField>
}

export type FilenameMode = "convention" | "custom"

export interface ManifestIssue {
  readonly issueId: string
  readonly issueKey: string
  readonly documentPath: string
  readonly filenameMode: FilenameMode
}

export interface SyncManifest {
  readonly version: 1
  readonly siteUrl: string
  readonly issues: ReadonlyArray<ManifestIssue>
}

export interface UserFieldValue {
  readonly accountId: string
  readonly displayName: string
}

export interface OptionFieldValue {
  readonly id?: string | undefined
  readonly value: string
}

export interface CascadingFieldValue {
  readonly parent: OptionFieldValue
  readonly child?: OptionFieldValue | undefined
}

export type SyncFieldScalar = string | number | boolean | null

export type SyncFieldValue =
  | SyncFieldScalar
  | UserFieldValue
  | OptionFieldValue
  | CascadingFieldValue
  | ReadonlyArray<string | number | boolean | UserFieldValue | OptionFieldValue>

export interface BaselineCustomField {
  readonly fieldId: string
  readonly displayName: string
  readonly shape: FieldShape
  readonly value: SyncFieldValue
}

export interface SyncBaselineFields {
  readonly summary: string
  readonly description: string
  readonly labels: ReadonlyArray<string>
  readonly customFields: Readonly<Record<string, BaselineCustomField>>
}

export interface SyncBaselineComment {
  readonly id: string
}

export interface SyncBaseline {
  readonly version: 1
  readonly issueId: string
  readonly issueKey: string
  readonly fields: SyncBaselineFields
  readonly comments: ReadonlyArray<SyncBaselineComment>
}

export interface IssueDocumentFrontMatter {
  readonly issueId: string
  readonly issueKey: string
  readonly summary: string
  readonly status: string
  readonly issueType: string
  readonly priority: string | null
  readonly assignee: UserFieldValue | null
  readonly reporter: UserFieldValue | null
  readonly labels: ReadonlyArray<string>
  readonly customFields: Readonly<Record<string, SyncFieldValue>>
}

export interface CommentDraft {
  readonly draftId: string
  readonly body: string
}

export interface AcceptedComment {
  readonly id: string
  readonly author: string
  readonly created: string
  readonly body: string
}

export interface AttachmentReference {
  readonly id: string
  readonly filename: string
  readonly url: string
  readonly mediaType: string | null
  readonly size: number | null
}

export interface IssueDocument {
  readonly frontMatter: IssueDocumentFrontMatter
  readonly description: string
  readonly multilineCustomFields: Readonly<Record<string, string>>
  readonly commentDrafts: ReadonlyArray<CommentDraft>
  readonly acceptedComments: ReadonlyArray<AcceptedComment>
  readonly attachments: ReadonlyArray<AttachmentReference>
  readonly localNotes: string
}

export type SyncFieldPath =
  | "summary"
  | "description"
  | "labels"
  | `customFields.${string}`
  | `readOnly.${string}`

export interface SyncValidationFailure {
  readonly _tag: "ValidationFailure"
  readonly message: string
  readonly issueKey?: string
  readonly field?: SyncFieldPath
  readonly path?: string
}

export interface SyncConflict {
  readonly issueId: string
  readonly issueKey: string
  readonly field: SyncFieldPath
  readonly baselineValue: SyncFieldValue
  readonly jiraValue: SyncFieldValue
  readonly documentValue: SyncFieldValue
}

export type PlannedFieldChange =
  | {
    readonly _tag: "RemoteOnly"
    readonly issueId: string
    readonly issueKey: string
    readonly field: SyncFieldPath
    readonly jiraValue: SyncFieldValue
  }
  | {
    readonly _tag: "LocalOnly"
    readonly issueId: string
    readonly issueKey: string
    readonly field: SyncFieldPath
    readonly documentValue: SyncFieldValue
  }
  | {
    readonly _tag: "Conflict"
    readonly issueId: string
    readonly issueKey: string
    readonly field: SyncFieldPath
    readonly baselineValue: SyncFieldValue
    readonly jiraValue: SyncFieldValue
    readonly documentValue: SyncFieldValue
  }

export interface SyncPlan {
  readonly changes: ReadonlyArray<PlannedFieldChange>
  readonly validationFailures: ReadonlyArray<SyncValidationFailure>
}
