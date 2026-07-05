import { describe, expect, it } from "vitest"
import { insertJiraAttachmentReference } from "../src/internal/attachmentInsertion.js"
import type { Attachment } from "../src/IssueService.js"

const attachment: Attachment = {
  id: "30001",
  filename: "diagram.svg",
  url: "https://example.atlassian.net/rest/api/3/attachment/content/30001",
  mediaType: "image/svg+xml",
  mimeType: "image/svg+xml",
  size: 448
}

describe("Jira attachment insertion", () => {
  it("preserves the placeholder label as rendered alt text", () => {
    const result = insertJiraAttachmentReference(
      "before\n![Architecture diagram](./diagram.svg)\nafter",
      "./diagram.svg",
      attachment
    )

    expect(result.content).toContain("![Architecture diagram]")
    expect(result.content).not.toContain("![diagram.svg]")
  })
})
