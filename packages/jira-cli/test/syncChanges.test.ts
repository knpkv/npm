import { describe, expect, it } from "@effect/vitest"
import { compareIssueFields } from "../src/internal/sync/changes.js"
import type { SyncBaselineFields } from "../src/internal/sync/types.js"

const fields = (overrides: Partial<SyncBaselineFields> = {}): SyncBaselineFields => ({
  summary: "Baseline summary",
  description: "Baseline description",
  labels: ["a", "b"],
  customFields: {
    Risk: {
      fieldId: "customfield_1",
      displayName: "Risk",
      shape: "singleSelect",
      value: { id: "1", value: "Low" }
    }
  },
  ...overrides
})

const compare = (
  jira: SyncBaselineFields,
  document: SyncBaselineFields,
  baseline: SyncBaselineFields = fields()
) =>
  compareIssueFields({
    issueId: "100123",
    issueKey: "PROJ-123",
    baseline,
    jira,
    document
  })

describe("compareIssueFields", () => {
  it("returns no changes when Jira and document match the baseline", () => {
    const result = compare(fields(), fields())
    expect(result.changes).toEqual([])
    expect(result.validationFailures).toEqual([])
  })

  it("classifies remote-only changes", () => {
    const result = compare(fields({ summary: "Remote summary" }), fields())
    expect(result.changes).toEqual([{
      _tag: "RemoteOnly",
      issueId: "100123",
      issueKey: "PROJ-123",
      field: "summary",
      jiraValue: "Remote summary"
    }])
  })

  it("classifies local-only changes", () => {
    const result = compare(fields(), fields({ description: "Local description" }))
    expect(result.changes).toEqual([{
      _tag: "LocalOnly",
      issueId: "100123",
      issueKey: "PROJ-123",
      field: "description",
      documentValue: "Local description"
    }])
  })

  it("classifies sync conflicts", () => {
    const result = compare(fields({ summary: "Remote summary" }), fields({ summary: "Local summary" }))
    expect(result.changes).toEqual([{
      _tag: "Conflict",
      issueId: "100123",
      issueKey: "PROJ-123",
      field: "summary",
      baselineValue: "Baseline summary",
      jiraValue: "Remote summary",
      documentValue: "Local summary"
    }])
  })

  it("compares custom fields", () => {
    const result = compare(
      fields(),
      fields({
        customFields: {
          Risk: {
            fieldId: "customfield_1",
            displayName: "Risk",
            shape: "singleSelect",
            value: { id: "2", value: "High" }
          }
        }
      })
    )

    expect(result.changes[0]).toMatchObject({
      _tag: "LocalOnly",
      field: "customFields.Risk",
      documentValue: { id: "2", value: "High" }
    })
  })

  it("reports missing custom fields as validation failures", () => {
    const result = compare(fields(), fields({ customFields: {} }))
    expect(result.validationFailures).toEqual([{
      _tag: "ValidationFailure",
      issueKey: "PROJ-123",
      field: "customFields.Risk",
      message: "Missing reconciled custom field \"Risk\""
    }])
  })
})
