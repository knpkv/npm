import { expect, expectTypeOf, it } from "@effect/vitest"
import type { CurrentReviewRunReading, ReviewRunWorkspaceReading, ReviewThread } from "@knpkv/review"
import type { FileDiff } from "@knpkv/rly/diff/patch"
import { Result } from "effect"
import {
  placeCurrentReviewFindings,
  placeReviewConversations,
  type ReviewParsedDiff
} from "../src/client/review-diff-placement.js"

const identity = {
  namespace: "codecommit",
  subjectId: "opaque-reference",
  revisionId: "revision-1",
  baseRevision: "base-1",
  headRevision: "head-1"
}
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
const thread = (id: string, anchor: ReviewThread["anchor"]): ReviewThread => ({
  id,
  source: "agent",
  finding,
  anchor,
  resolved: false,
  messages: []
})
const reading = (threads: ReadonlyArray<ReviewThread>): CurrentReviewRunReading => ({
  _tag: "Current",
  run: {
    id: "run-1",
    identity,
    profile: null,
    kind: "review",
    completedAt: 1_000,
    summary: "Recorded verdict",
    explanation: null,
    risks: null,
    focus: null,
    rules: null,
    threads
  }
})
const renamed = {
  path: "src/new.ts",
  oldPath: "src/old.ts",
  newPath: "src/new.ts",
  status: "renamed",
  binary: false,
  hunks: [{
    header: "",
    oldStart: 10,
    newStart: 20,
    lines: [
      { kind: "context", oldNo: 10, newNo: 20, text: "context" },
      { kind: "del", oldNo: 11, text: "old" },
      { kind: "add", newNo: 21, text: "new" }
    ]
  }]
} satisfies FileDiff
const diff = { identity, files: [{ index: 3, file: renamed }] } satisfies ReviewParsedDiff
const anchor = (path: string, side: "before" | "after", line: number): ReviewThread["anchor"] => ({
  _tag: "Line",
  path,
  side,
  line,
  outdated: false
})

it("only accepts Current and refuses any mismatch in the complete immutable identity", () => {
  expectTypeOf<Parameters<typeof placeCurrentReviewFindings>[0]>().toEqualTypeOf<CurrentReviewRunReading>()
  expectTypeOf<Extract<ReviewRunWorkspaceReading, { readonly _tag: "DifferentRevision" }>>().not.toExtend<
    CurrentReviewRunReading
  >()
  for (
    const changed of [
      { ...identity, namespace: "other" },
      { ...identity, subjectId: "other" },
      { ...identity, revisionId: "other" },
      { ...identity, baseRevision: "other" },
      { ...identity, baseRevision: null },
      { ...identity, headRevision: "other" }
    ]
  ) {
    const result = placeCurrentReviewFindings(reading([]), { ...diff, identity: changed })
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) expect(result.failure.reason).toBe("identity_mismatch")
  }
})

it("places only numbered hunk records on their exact rename side, retaining every other finding once", () => {
  const threads = [
    thread("old", anchor("src/old.ts", "before", 11)),
    thread("new", anchor("src/new.ts", "after", 21)),
    thread("wrong-name", anchor("src/new.ts", "before", 11)),
    thread("wrong-side", anchor("src/old.ts", "after", 21)),
    thread("outside-hunk", anchor("src/new.ts", "after", 1)),
    thread("absent-line", anchor("src/new.ts", "after", 99)),
    thread("old-reading", { _tag: "Line", path: "src/new.ts", side: "after", line: 21, outdated: true }),
    thread("file", { _tag: "File", path: "src/new.ts", outdated: false }),
    thread("general", { _tag: "Unanchored" })
  ]
  const before = JSON.stringify([threads, diff])
  const result = placeCurrentReviewFindings(reading(threads), diff)
  expect(Result.isSuccess(result)).toBe(true)
  if (Result.isSuccess(result)) {
    expect(result.success.placed.map(({ fileIndex, line, row, side }) => [row.thread.id, fileIndex, side, line]))
      .toEqual([
        ["old", 3, "old", 11],
        ["new", 3, "new", 21]
      ])
    expect(result.success.unplaced.map(({ thread }) => thread.id)).toEqual(threads.slice(2).map(({ id }) => id))
    expect(result.success.placed[0]?.row.thread).toBe(threads[0])
    expect(result.success.unplaced[0]?.thread).toBe(threads[2])
  }
  expect(JSON.stringify([threads, diff])).toBe(before)
})

it("places globally after all eligible files so a second-file finding never gets a duplicate fallback", () => {
  const second = {
    ...renamed,
    path: "second.ts",
    oldPath: "second.ts",
    newPath: "second.ts",
    status: "modified"
  } satisfies FileDiff
  const threads = [
    thread("second", anchor("second.ts", "after", 21)),
    thread("missing", anchor("missing.ts", "after", 21))
  ]
  const result = placeCurrentReviewFindings(reading(threads), {
    identity,
    files: [...diff.files, { index: 4, file: second }]
  })
  expect(Result.isSuccess(result)).toBe(true)
  if (Result.isSuccess(result)) {
    expect(result.success.placed.map(({ fileIndex, row }) => [row.thread.id, fileIndex])).toEqual([["second", 4]])
    expect(result.success.unplaced.map(({ thread }) => thread.id)).toEqual(["missing"])
    expect(
      new Set([
        ...result.success.placed.map(({ row }) => row.thread.id),
        ...result.success.unplaced.map(({ thread }) => thread.id)
      ]).size
    ).toBe(threads.length)
  }
  for (
    const files of [
      [...diff.files, { index: 3, file: second }],
      [...diff.files, { index: 4, file: renamed }]
    ]
  ) {
    const invalid = placeCurrentReviewFindings(reading(threads), { identity, files })
    expect(Result.isFailure(invalid)).toBe(true)
    if (Result.isFailure(invalid)) expect(invalid.failure.reason).toBe("duplicate_file")
  }
})

it("retains all rows when no file is eligible and never places a finding on an absent side", () => {
  const threads = [thread("old", anchor("src/old.ts", "before", 11)), thread("new", anchor("src/new.ts", "after", 21))]
  const absent = placeCurrentReviewFindings(reading(threads), { identity, files: [] })
  expect(Result.isSuccess(absent)).toBe(true)
  if (Result.isSuccess(absent)) expect(absent.success.unplaced.map(({ thread }) => thread.id)).toEqual(["old", "new"])
  for (const status of ["added", "deleted"] satisfies ReadonlyArray<FileDiff["status"]>) {
    const result = placeCurrentReviewFindings(reading(threads), {
      identity,
      files: [{ index: 3, file: { ...renamed, status } }]
    })
    expect(Result.isSuccess(result)).toBe(true)
    if (Result.isSuccess(result)) {
      expect(result.success.placed.map(({ row }) => row.thread.id)).toEqual(status === "added" ? ["new"] : ["old"])
    }
  }
})

it("keeps ambiguous source-copy anchors separate instead of picking the first matching file", () => {
  const first = { ...renamed, status: "copied" } satisfies FileDiff
  const second = { ...first, path: "src/copy.ts", newPath: "src/copy.ts" } satisfies FileDiff
  const threads = [thread("source", anchor("src/old.ts", "before", 11))]
  const result = placeCurrentReviewFindings(reading(threads), {
    identity,
    files: [{ index: 0, file: first }, { index: 1, file: second }]
  })
  expect(Result.isSuccess(result)).toBe(true)
  if (Result.isSuccess(result)) {
    expect(result.success.placed).toEqual([])
    expect(result.success.unplaced[0]?.thread).toBe(threads[0])
  }
})

it("places current discussions on exact rename sides and refuses mismatched or duplicate parsed readings", () => {
  const comments = [
    thread("before", anchor("src/old.ts", "before", 11)),
    thread("after", anchor("src/new.ts", "after", 21)),
    thread("outside", anchor("src/new.ts", "after", 99)),
    thread("outdated", { _tag: "Line", path: "src/new.ts", side: "after", line: 21, outdated: true })
  ].map((value) => ({ ...value, source: "codecommit", finding: null } satisfies ReviewThread))
  const result = placeReviewConversations(identity, comments, diff)
  expect(Result.isSuccess(result)).toBe(true)
  if (Result.isSuccess(result)) {
    expect(result.success.map(({ fileIndex, line, side, thread }) => [thread.id, fileIndex, side, line])).toEqual([[
      "before",
      3,
      "old",
      11
    ], ["after", 3, "new", 21]])
  }
  for (
    const invalid of [
      { ...diff, identity: { ...identity, headRevision: "other" } },
      { ...diff, files: [...diff.files, ...diff.files] }
    ]
  ) expect(Result.isFailure(placeReviewConversations(identity, comments, invalid))).toBe(true)
})
