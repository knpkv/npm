/**
 * Baseline comparison for Jira Markdown Sync planning.
 *
 * @internal
 */
import { fieldValuesEqual } from "./fieldValues.js"
import type {
  PlannedFieldChange,
  SyncBaselineFields,
  SyncFieldPath,
  SyncFieldValue,
  SyncValidationFailure
} from "./types.js"

export interface CompareIssueFieldsInput {
  readonly issueId: string
  readonly issueKey: string
  readonly baseline: SyncBaselineFields
  readonly jira: SyncBaselineFields
  readonly document: SyncBaselineFields
}

export interface CompareIssueFieldsResult {
  readonly changes: ReadonlyArray<PlannedFieldChange>
  readonly validationFailures: ReadonlyArray<SyncValidationFailure>
}

export const compareIssueFields = (input: CompareIssueFieldsInput): CompareIssueFieldsResult => {
  const changes: Array<PlannedFieldChange> = []
  const validationFailures: Array<SyncValidationFailure> = []

  compareField(input, "summary", input.baseline.summary, input.jira.summary, input.document.summary, changes)
  compareField(
    input,
    "description",
    input.baseline.description,
    input.jira.description,
    input.document.description,
    changes
  )
  compareField(input, "labels", input.baseline.labels, input.jira.labels, input.document.labels, changes)

  const customFieldNames = new Set([
    ...Object.keys(input.baseline.customFields),
    ...Object.keys(input.jira.customFields),
    ...Object.keys(input.document.customFields)
  ])

  for (const name of customFieldNames) {
    const field: SyncFieldPath = `customFields.${name}`
    const baseline = input.baseline.customFields[name]?.value
    const jira = input.jira.customFields[name]?.value
    const document = input.document.customFields[name]?.value

    if (baseline === undefined || jira === undefined || document === undefined) {
      validationFailures.push({
        _tag: "ValidationFailure",
        issueKey: input.issueKey,
        field,
        message: `Missing reconciled custom field "${name}"`
      })
      continue
    }

    compareField(input, field, baseline, jira, document, changes)
  }

  return { changes, validationFailures }
}

const compareField = (
  input: Pick<CompareIssueFieldsInput, "issueId" | "issueKey">,
  field: SyncFieldPath,
  baselineValue: SyncFieldValue,
  jiraValue: SyncFieldValue,
  documentValue: SyncFieldValue,
  changes: Array<PlannedFieldChange>
) => {
  const jiraChanged = !syncFieldValueEquals(jiraValue, baselineValue)
  const documentChanged = !syncFieldValueEquals(documentValue, baselineValue)

  if (!jiraChanged && !documentChanged) return

  if (jiraChanged && !documentChanged) {
    changes.push({
      _tag: "RemoteOnly",
      issueId: input.issueId,
      issueKey: input.issueKey,
      field,
      jiraValue
    })
    return
  }

  if (!jiraChanged && documentChanged) {
    changes.push({
      _tag: "LocalOnly",
      issueId: input.issueId,
      issueKey: input.issueKey,
      field,
      documentValue
    })
    return
  }

  changes.push({
    _tag: "Conflict",
    issueId: input.issueId,
    issueKey: input.issueKey,
    field,
    baselineValue,
    jiraValue,
    documentValue
  })
}

export const syncFieldValueEquals = (left: SyncFieldValue, right: SyncFieldValue): boolean =>
  fieldValuesEqual(left, right)
