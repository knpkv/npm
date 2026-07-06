import { describe, expect, it } from "@effect/vitest"
import { parseIssueDocument, serializeIssueDocument } from "../src/internal/sync/document.js"
import type { IssueDocument } from "../src/internal/sync/types.js"
import { SyncValidationError } from "../src/JiraCliError.js"

const document: IssueDocument = {
  frontMatter: {
    issueId: "100123",
    issueKey: "PROJ-123",
    summary: "Fix checkout copy",
    status: "In Progress",
    issueType: "Story",
    priority: "Medium",
    assignee: { accountId: "abc123", displayName: "Alice Example" },
    reporter: null,
    labels: ["checkout", "copy"],
    customFields: {
      "Security & Compliance Impact": { id: "10423", value: "Low" }
    }
  },
  description: "Editable description markdown.",
  multilineCustomFields: {
    "Release Notes": "Multiline release notes."
  },
  commentDrafts: [{ draftId: "draft-1", body: "Please review this." }],
  acceptedComments: [{
    id: "20001",
    author: "Alice Example",
    created: "2026-06-27",
    body: "Existing Jira comment."
  }],
  attachments: [{
    id: "30001",
    filename: "evidence.png",
    url: "https://example.atlassian.net/evidence.png",
    mediaType: "image/png",
    size: 1234
  }],
  localNotes: "Private local note."
}

describe("Issue Document parsing", () => {
  it("round-trips a representative issue document", () => {
    const serialized = serializeIssueDocument(document)
    const parsed = parseIssueDocument("PROJ-123.md", serialized)
    expect(parsed).toEqual(document)
  })

  it("preserves local notes body text", () => {
    const serialized = serializeIssueDocument({
      ...document,
      localNotes: "line one\n\n- private bullet"
    })
    const parsed = parseIssueDocument("PROJ-123.md", serialized)
    expect(parsed.localNotes).toBe("line one\n\n- private bullet")
  })

  it("rejects missing description section", () => {
    const serialized = serializeIssueDocument(document).replace(
      /## Description[\s\S]*?## Release Notes/,
      "## Release Notes"
    )
    expect(() => parseIssueDocument("PROJ-123.md", serialized)).toThrow(SyncValidationError)
  })

  it("rejects duplicate sections", () => {
    const serialized = `${serializeIssueDocument(document)}\n## Description\n\nagain\n`
    expect(() => parseIssueDocument("PROJ-123.md", serialized)).toThrow(SyncValidationError)
  })

  it("rejects malformed comment draft markers", () => {
    const serialized = serializeIssueDocument(document).replace("<!-- draftId: draft-1 -->", "<!-- draft: draft-1 -->")
    expect(() => parseIssueDocument("PROJ-123.md", serialized)).toThrow(SyncValidationError)
  })

  it("renders image attachments inline with hidden identity metadata", () => {
    const serialized = serializeIssueDocument(document)
    expect(serialized).toContain(
      "<!-- jiraAttachment: {\"jiraAttachmentId\":\"30001\",\"mediaType\":\"image/png\",\"size\":1234} -->"
    )
    expect(serialized).toContain("![evidence.png](https://example.atlassian.net/evidence.png)")
  })

  it("keeps parsing legacy attachment link lines", () => {
    const serialized = serializeIssueDocument(document).replace(
      /<!-- jiraAttachment:[\s\S]*?\n!\[evidence\.png]\(https:\/\/example\.atlassian\.net\/evidence\.png\)/,
      "- [evidence.png](https://example.atlassian.net/evidence.png)"
    )
    const parsed = parseIssueDocument("PROJ-123.md", serialized)
    expect(parsed.attachments).toEqual([{
      id: "",
      filename: "evidence.png",
      url: "https://example.atlassian.net/evidence.png",
      mediaType: null,
      size: null
    }])
  })
})
