import { describe, expect, it } from "@effect/vitest"
import * as yaml from "js-yaml"
import { extractFrontMatter, serializeIssue } from "../src/internal/frontmatter.js"
import type { Issue } from "../src/IssueService.js"

/**
 * Parse the YAML front-matter block of a serialized issue using js-yaml 4
 * directly. We avoid gray-matter's default parser here because it calls the
 * removed `safeLoad` — the same incompatibility this module works around.
 */
const parseFrontMatter = (output: string): Record<string, unknown> => {
  const match = output.match(/^---\n([\s\S]*?)\n---/)
  const parsed = match ? yaml.load(match[1]) : {}
  return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
    ? Object.fromEntries(Object.entries(parsed))
    : {}
}

const makeIssue = (overrides: Partial<Issue> = {}): Issue => ({
  key: "OOB-81",
  id: "10081",
  summary: "Test ticket",
  status: "Done",
  type: "Story",
  priority: "High",
  assignee: "Alice",
  reporter: "Bob",
  created: new Date("2026-01-01T00:00:00.000Z"),
  updated: new Date("2026-02-01T00:00:00.000Z"),
  fixVersions: ["OOB 81"],
  labels: ["a", "b"],
  components: ["x"],
  description: "Hello",
  attachments: [],
  comments: [],
  ...overrides
})

describe("frontmatter", () => {
  describe("serializeIssue", () => {
    // Regression: gray-matter's default YAML engine calls js-yaml's removed
    // `safeDump`, which throws under the workspace's js-yaml 4 override. The
    // custom engine must serialize without throwing.
    it("serializes without throwing under js-yaml 4", () => {
      expect(() => serializeIssue(makeIssue())).not.toThrow()
    })

    it("produces parseable YAML front-matter round-tripping the data", () => {
      const output = serializeIssue(makeIssue())
      const data = parseFrontMatter(output)
      expect(data.key).toBe("OOB-81")
      expect(data.fixVersions).toEqual(["OOB 81"])
      expect(data.labels).toEqual(["a", "b"])
      expect(output).toContain("# OOB-81: Test ticket")
    })

    it("emits null for absent optional fields", () => {
      const output = serializeIssue(makeIssue({ priority: null, assignee: null, reporter: null }))
      const data = parseFrontMatter(output)
      expect(data.priority).toBeNull()
      expect(data.assignee).toBeNull()
    })

    it("renders image and SVG attachments as inline previews with identity metadata", () => {
      const output = serializeIssue(makeIssue({
        attachments: [{
          id: "10001",
          filename: "diagram.svg",
          url: "https://example.atlassian.net/rest/api/3/attachment/content/10001",
          mediaType: "application/octet-stream",
          size: 42
        }]
      }))
      expect(output).toContain(
        "<!-- jiraAttachment: {\"jiraAttachmentId\":\"10001\",\"mediaType\":\"application/octet-stream\",\"size\":42} -->"
      )
      expect(output).toContain("![diagram.svg](https://example.atlassian.net/rest/api/3/attachment/content/10001)")
    })
  })

  describe("extractFrontMatter", () => {
    it("renders dates as ISO strings", () => {
      const fm = extractFrontMatter(makeIssue())
      expect(fm.created).toBe("2026-01-01T00:00:00.000Z")
      expect(fm.updated).toBe("2026-02-01T00:00:00.000Z")
    })
  })
})
