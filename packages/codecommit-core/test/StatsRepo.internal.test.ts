import { describe, expect, it } from "@effect/vitest"
import { extractComments, parseFilter } from "../src/CacheService/repos/StatsRepo/internal.js"
import type { PRCommentLocationJson } from "../src/Domain.js"

// Helper: builds a comment thread node with author + creationDate
const thread = (
  author: string,
  date: string,
  replies: Array<typeof PRCommentLocationJson.Type["comments"][number]> = []
): typeof PRCommentLocationJson.Type["comments"][number] => ({
  root: { id: `c-${date}`, content: "", author, creationDate: date, deleted: false },
  replies
})

describe("StatsRepo/internal", () => {
  describe("extractComments", () => {
    // Edge case: location with no comments → empty array
    // Happens for file-level locations that have no threads yet
    it("returns empty for no comments", () => {
      expect(extractComments([{ comments: [] }])).toEqual([])
    })

    // Base case: single root comment without replies → one entry
    it("extracts single root comment", () => {
      const result = extractComments([{
        comments: [thread("alice", "2026-01-01T10:00:00Z")]
      }])
      expect(result).toHaveLength(1)
      expect(result[0]!.author).toBe("alice")
    })

    // Core behavior: nested replies must be flattened recursively
    // A thread with root → reply → reply-to-reply should produce 3 entries
    it("flattens nested replies recursively", () => {
      const result = extractComments([{
        comments: [
          thread("alice", "2026-01-01T10:00:00Z", [
            thread("bob", "2026-01-01T11:00:00Z", [
              thread("charlie", "2026-01-01T12:00:00Z")
            ])
          ])
        ]
      }])
      expect(result).toHaveLength(3)
      expect(result.map((c) => c.author)).toEqual(["alice", "bob", "charlie"])
    })

    // Multiple locations (file-level groupings) must all be traversed
    // Stats dashboard aggregates across all file locations in a PR
    it("aggregates across multiple locations", () => {
      const result = extractComments([
        { comments: [thread("alice", "2026-01-01T10:00:00Z")] },
        { comments: [thread("bob", "2026-01-02T10:00:00Z")] }
      ])
      expect(result).toHaveLength(2)
    })

    // Date parsing: creationDate strings must become Date objects
    // reviewerData sorts by creationDate.getTime() — wrong parsing = wrong reviewer rankings
    it("parses creationDate as Date", () => {
      const result = extractComments([{
        comments: [thread("alice", "2026-03-01T14:30:00Z")]
      }])
      expect(result[0]!.creationDate).toBeInstanceOf(Date)
      expect(result[0]!.creationDate.toISOString()).toBe("2026-03-01T14:30:00.000Z")
    })
  })

  describe("parseFilter", () => {
    // undefined input → undefined (no filter applied)
    // URL params omit the key entirely when no filter is set
    it("returns undefined for undefined input", () => {
      expect(parseFilter(undefined)).toBeUndefined()
    })

    // Empty string → undefined (same as no filter)
    it("returns undefined for empty string", () => {
      expect(parseFilter("")).toBeUndefined()
    })

    // Single value: most common case — user clicks one repo/author filter
    it("parses single value", () => {
      expect(parseFilter("repo-a")).toEqual(["repo-a"])
    })

    // Comma-separated: stats dashboard supports multi-select filters
    // e.g. "repo-a,repo-b" → both repos included in WHERE IN clause
    it("parses comma-separated values", () => {
      expect(parseFilter("repo-a,repo-b")).toEqual(["repo-a", "repo-b"])
    })

    // Whitespace tolerance: URL-encoded spaces or user-typed spaces
    it("trims whitespace around values", () => {
      expect(parseFilter("  repo-a , repo-b  ")).toEqual(["repo-a", "repo-b"])
    })

    // Trailing comma or double comma should not produce empty entries
    // which would cause SQL IN ('') — matching nothing
    it("filters out empty entries from trailing commas", () => {
      expect(parseFilter("repo-a,,repo-b,")).toEqual(["repo-a", "repo-b"])
    })
  })
})
