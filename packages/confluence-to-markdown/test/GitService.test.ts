import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { GitService, layer as GitServiceLayer } from "../src/GitService.js"
import { getConflictedFiles, GIT_LOG_FORMAT, parseGitLog, parseGitStatus } from "../src/internal/gitCommands.js"

/**
 * Tests for git parsing utilities and GitService.
 */
describe("GitService", () => {
  describe("parseGitStatus", () => {
    it("parses empty status", () => {
      const entries = parseGitStatus("")
      expect(entries).toEqual([])
    })

    it("parses whitespace-only status", () => {
      const entries = parseGitStatus("   \n  ")
      expect(entries).toEqual([])
    })

    it("parses modified file", () => {
      const entries = parseGitStatus(" M src/file.ts")
      expect(entries).toHaveLength(1)
      expect(entries[0]).toEqual({
        status: "modified",
        path: "src/file.ts",
        staged: false
      })
    })

    it("parses staged modified file", () => {
      const entries = parseGitStatus("M  src/file.ts")
      expect(entries).toHaveLength(1)
      expect(entries[0]).toEqual({
        status: "modified",
        path: "src/file.ts",
        staged: true
      })
    })

    it("parses added file", () => {
      const entries = parseGitStatus("A  new-file.ts")
      expect(entries).toHaveLength(1)
      expect(entries[0]).toEqual({
        status: "added",
        path: "new-file.ts",
        staged: true
      })
    })

    it("parses deleted file", () => {
      const entries = parseGitStatus("D  removed.ts")
      expect(entries).toHaveLength(1)
      expect(entries[0]).toEqual({
        status: "deleted",
        path: "removed.ts",
        staged: true
      })
    })

    it("parses untracked file", () => {
      const entries = parseGitStatus("?? untracked.ts")
      expect(entries).toHaveLength(1)
      expect(entries[0]).toEqual({
        status: "untracked",
        path: "untracked.ts",
        staged: false
      })
    })

    it("parses unmerged file", () => {
      const entries = parseGitStatus("UU conflicted.ts")
      expect(entries).toHaveLength(1)
      expect(entries[0]).toEqual({
        status: "unmerged",
        path: "conflicted.ts",
        staged: true
      })
    })

    it("parses multiple entries", () => {
      const output = `M  staged.ts
 M unstaged.ts
?? new.ts`
      const entries = parseGitStatus(output)
      expect(entries).toHaveLength(3)
      expect(entries[0]?.status).toBe("modified")
      expect(entries[0]?.staged).toBe(true)
      expect(entries[1]?.status).toBe("modified")
      expect(entries[1]?.staged).toBe(false)
      expect(entries[2]?.status).toBe("untracked")
    })

    it("parses renamed file", () => {
      const entries = parseGitStatus("R  old.ts -> new.ts")
      expect(entries).toHaveLength(1)
      expect(entries[0]).toEqual({
        status: "renamed",
        path: "old.ts -> new.ts",
        staged: true
      })
    })
  })

  describe("parseGitLog", () => {
    it("parses empty log", () => {
      const entries = parseGitLog("")
      expect(entries).toEqual([])
    })

    it("parses whitespace-only log", () => {
      const entries = parseGitLog("  \n  ")
      expect(entries).toEqual([])
    })

    it("parses single log entry", () => {
      const output = "abc123<|>John Doe<|>john@example.com<|>2024-01-15T10:30:00Z<|>Initial commit"
      const entries = parseGitLog(output)
      expect(entries).toHaveLength(1)
      expect(entries[0]).toEqual({
        hash: "abc123",
        author: "John Doe",
        email: "john@example.com",
        date: new Date("2024-01-15T10:30:00Z"),
        message: "Initial commit"
      })
    })

    it("parses multiple log entries", () => {
      const output = `abc123<|>John Doe<|>john@example.com<|>2024-01-15T10:30:00Z<|>First commit
def456<|>Jane Smith<|>jane@example.com<|>2024-01-16T11:00:00Z<|>Second commit`
      const entries = parseGitLog(output)
      expect(entries).toHaveLength(2)
      expect(entries[0]?.hash).toBe("abc123")
      expect(entries[1]?.hash).toBe("def456")
    })

    it("handles message with delimiter characters", () => {
      const output = "abc123<|>John<|>john@test.com<|>2024-01-15T10:30:00Z<|>Fix: a<|>b issue"
      const entries = parseGitLog(output)
      expect(entries).toHaveLength(1)
      expect(entries[0]?.message).toBe("Fix: a<|>b issue")
    })

    it("skips malformed entries", () => {
      const output = `abc123<|>John<|>john@test.com<|>2024-01-15T10:30:00Z<|>Valid
malformed entry without enough parts
def456<|>Jane<|>jane@test.com<|>2024-01-16T11:00:00Z<|>Also valid`
      const entries = parseGitLog(output)
      expect(entries).toHaveLength(2)
      expect(entries[0]?.hash).toBe("abc123")
      expect(entries[1]?.hash).toBe("def456")
    })
  })

  describe("getConflictedFiles", () => {
    it("returns empty array for no conflicts", () => {
      const output = `M  file.ts
?? new.ts`
      const files = getConflictedFiles(output)
      expect(files).toEqual([])
    })

    it("returns conflicted files", () => {
      const output = `M  normal.ts
UU conflicted.ts
?? new.ts`
      const files = getConflictedFiles(output)
      expect(files).toEqual(["conflicted.ts"])
    })

    it("returns multiple conflicted files", () => {
      const output = `UU file1.ts
UU file2.ts
M  normal.ts`
      const files = getConflictedFiles(output)
      expect(files).toHaveLength(2)
      expect(files).toContain("file1.ts")
      expect(files).toContain("file2.ts")
    })
  })

  describe("GIT_LOG_FORMAT", () => {
    it("contains expected format specifiers", () => {
      expect(GIT_LOG_FORMAT).toContain("%H") // full hash
      expect(GIT_LOG_FORMAT).toContain("%an") // author name
      expect(GIT_LOG_FORMAT).toContain("%ae") // author email
      expect(GIT_LOG_FORMAT).toContain("%aI") // author date ISO
      expect(GIT_LOG_FORMAT).toContain("%s") // subject
      expect(GIT_LOG_FORMAT).toContain("<|>") // delimiter
    })
  })

  describe("GitService layer", () => {
    it.effect("validates git is available", () =>
      Effect.gen(function*() {
        const git = yield* GitService
        const version = yield* git.validateGit()
        expect(version).toContain("git version")
      }).pipe(Effect.provide(GitServiceLayer)))

    it.effect("isInitialized returns boolean", () =>
      Effect.gen(function*() {
        const git = yield* GitService
        const initialized = yield* git.isInitialized()
        expect(typeof initialized).toBe("boolean")
      }).pipe(Effect.provide(GitServiceLayer)))
  })
})
