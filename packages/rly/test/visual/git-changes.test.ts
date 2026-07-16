import { describe, expect, it } from "vitest"
import { GitChangesError, parseGitNameStatus } from "../../scripts/visual/git-changes.js"

describe("Git name-status parser", () => {
  it("parses added, modified, deleted, renamed, and copied records", () => {
    expect(parseGitNameStatus(
      "A\0new file.ts\0M\0updated.ts\0D\0deleted.ts\0R100\0old.ts\0new.ts\0C090\0source.ts\0copy.ts\0"
    )).toEqual([
      { path: "new file.ts", status: "added" },
      { path: "updated.ts", status: "modified" },
      { path: "deleted.ts", status: "deleted" },
      { path: "new.ts", previousPath: "old.ts", status: "renamed" },
      { path: "copy.ts", previousPath: "source.ts", status: "copied" }
    ])
  })

  it("preserves newlines and spaces in NUL-delimited paths", () => {
    expect(parseGitNameStatus("M\0path with space\nand newline.ts\0")).toEqual([
      { path: "path with space\nand newline.ts", status: "modified" }
    ])
  })

  it("maps unsafe Git statuses to conservative classifier states", () => {
    expect(parseGitNameStatus("T\0typed.ts\0U\0merged.ts\0X\0unknown.ts\0B\0broken.ts\0")).toEqual([
      { path: "typed.ts", status: "type-changed" },
      { path: "merged.ts", status: "unmerged" },
      { path: "unknown.ts", status: "unknown" },
      { path: "broken.ts", status: "unknown" }
    ])
  })

  it("rejects truncated and unsupported output", () => {
    expect(() => parseGitNameStatus("M\0missing terminator")).toThrow(GitChangesError)
    expect(() => parseGitNameStatus("R100\0only-old\0")).toThrow("Missing changed path")
    expect(() => parseGitNameStatus("Z\0mystery\0")).toThrow("Unsupported change status")
  })
})
