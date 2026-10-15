import { expect, it } from "@effect/vitest"
import type { CurrentReviewRunReading, ReviewThread } from "@knpkv/review"
import { Result } from "effect"
import { parseReviewDiffFile } from "../src/client/review-diff-file.js"
import { placeCurrentReviewFindings } from "../src/client/review-diff-placement.js"
import type { CodeDiff, CodeDiffContent } from "../src/host-contract.js"

const file = {
  index: 0,
  status: "modified",
  path: "src/file.ts",
  previousPath: null,
  beforeMode: "100644",
  afterMode: "100644"
} satisfies CodeDiff["files"][number]
const content = {
  fileIndex: 0,
  revisionId: "revision-1",
  state: "text",
  before: "old\n",
  after: "new\n"
} satisfies CodeDiffContent
const identity = {
  namespace: "codecommit",
  subjectId: "opaque-reference",
  revisionId: "revision-1",
  baseRevision: "base-1",
  headRevision: "head-1"
}

it("round-trips real framed producer output through Rly with renamed before/after paths and literal a/b prefixes", () => {
  for (
    const [previousPath, path] of [
      ["src/old.ts", "src/new.ts"],
      ["a/old.ts", "b/new.ts"],
      ["src/old\t雪\".ts", "src/new\t雪\".ts"],
      ["src/old name.ts", "src/new name.ts"]
    ] satisfies ReadonlyArray<readonly [string, string]>
  ) {
    const result = parseReviewDiffFile({ ...file, status: "renamed", previousPath, path }, "revision-1", content)
    expect(Result.isSuccess(result), JSON.stringify([previousPath, path])).toBe(true)
    if (Result.isSuccess(result)) {
      expect([result.success.oldPath, result.success.newPath, result.success.path, result.success.status]).toEqual([
        previousPath,
        path,
        path,
        "renamed"
      ])
      expect(result.success.hunks.flatMap(({ lines }) => lines.map(({ kind, newNo, oldNo }) => [kind, oldNo, newNo])))
        .toEqual([
          ["del", 1, undefined],
          ["add", undefined, 1]
        ])
    }
  }
})

it("preserves empty additions/deletions and mode-only changes without inventing a text hunk or file side", () => {
  for (
    const [metadata, value, expected] of [
      [{ ...file, status: "added", beforeMode: null }, { ...content, before: null, after: "" }, "added"],
      [{ ...file, status: "deleted", afterMode: null }, { ...content, before: "", after: null }, "deleted"],
      [{ ...file, afterMode: "100755" }, { ...content, before: "same\n", after: "same\n" }, "modified"]
    ] satisfies ReadonlyArray<readonly [CodeDiff["files"][number], CodeDiffContent, string]>
  ) {
    const result = parseReviewDiffFile(metadata, "revision-1", value)
    expect(Result.isSuccess(result)).toBe(true)
    if (Result.isSuccess(result)) {
      expect(result.success.status).toBe(expected)
      expect(result.success.hunks).toEqual([])
      expect(result.success.oldMode ?? null).toBe(metadata.beforeMode)
      expect(result.success.newMode ?? null).toBe(metadata.afterMode)
    }
  }
})

it("uses actual absent-side markers for non-empty addition/deletion hunks", () => {
  for (
    const [metadata, value, side] of [
      [{ ...file, status: "added", beforeMode: null }, { ...content, before: null }, "new"],
      [{ ...file, status: "deleted", afterMode: null }, { ...content, after: null }, "old"]
    ] satisfies ReadonlyArray<readonly [CodeDiff["files"][number], CodeDiffContent, "old" | "new"]>
  ) {
    const result = parseReviewDiffFile(metadata, "revision-1", value)
    expect(Result.isSuccess(result)).toBe(true)
    if (Result.isSuccess(result)) {
      const lines = result.success.hunks.flatMap(({ lines }) => lines)
      expect(lines).toHaveLength(1)
      expect(lines[0]?.oldNo).toBe(side === "old" ? 1 : undefined)
      expect(lines[0]?.newNo).toBe(side === "new" ? 1 : undefined)
    }
  }
})

it("refuses foreign/missing content, exceptional content and display bounds before inline placement", () => {
  const finding = {
    severity: "P1",
    axis: null,
    confidence: null,
    claim: "Recorded claim",
    summary: null,
    why: "Recorded evidence",
    recommendation: "",
    verification: "",
    requirement: null,
    patch: null,
    disposition: { _tag: "Open" }
  } satisfies NonNullable<ReviewThread["finding"]>
  const thread = {
    id: "finding",
    source: "agent",
    finding,
    anchor: { _tag: "Line", path: file.path, side: "after", line: 1, outdated: false },
    resolved: false,
    messages: []
  } satisfies ReviewThread
  const reading = {
    _tag: "Current",
    run: {
      id: "run",
      identity,
      kind: "review",
      profile: null,
      completedAt: 1_000,
      summary: "Recorded verdict",
      explanation: null,
      risks: null,
      focus: null,
      rules: null,
      threads: [thread]
    }
  } satisfies CurrentReviewRunReading
  for (
    const [value, expected] of [
      [{ ...content, revisionId: "other" }, "wrong_content"],
      [{ ...content, fileIndex: 1 }, "wrong_content"],
      [{ ...content, before: null }, "wrong_content"],
      [{ ...content, state: "binary" }, "binary"],
      [{ ...content, state: "oversized" }, "oversized"],
      [{ ...content, after: "x".repeat(102_401) }, "display_limit"],
      [{ ...content, after: "x\n".repeat(2_001) }, "display_limit"]
    ] satisfies ReadonlyArray<readonly [CodeDiffContent, string]>
  ) {
    const result = parseReviewDiffFile(file, "revision-1", value)
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) expect(result.failure.reason).toBe(expected)
    const placement = placeCurrentReviewFindings(reading, {
      identity,
      files: Result.isSuccess(result) ? [{ index: file.index, file: result.success }] : []
    })
    expect(Result.isSuccess(placement)).toBe(true)
    if (Result.isSuccess(placement)) {
      expect(placement.success.placed).toEqual([])
      expect(placement.success.unplaced[0]?.thread).toBe(thread)
    }
  }
  for (
    const metadata of [{ ...file, status: "renamed", previousPath: null }, { ...file, path: "src/invalid\u0000.ts" }, {
      ...file,
      afterMode: "100755\nnew file mode 100644"
    }] satisfies ReadonlyArray<CodeDiff["files"][number]>
  ) {
    expect(Result.isFailure(parseReviewDiffFile(metadata, "revision-1", content))).toBe(true)
  }
})
