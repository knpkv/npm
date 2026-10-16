import { Schema } from "effect"
import { expect, expectTypeOf, it } from "vitest"
import {
  currentReviewLineFindings,
  type CurrentReviewRunReading,
  reviewRunReadingForWorkspace,
  type ReviewRunWorkspaceReading
} from "../src/workspace-run-reading.js"
import { type ReviewRun, type ReviewThread, ReviewWorkspace } from "../src/workspace.js"

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
  patch: { path: "src/example.ts", headRevision: "head-1", text: "- old\n+ new" },
  disposition: { _tag: "Open" }
} satisfies NonNullable<ReviewThread["finding"]>
const line = {
  id: "line",
  source: "agent",
  anchor: { _tag: "Line", path: "src/example.ts", line: 8, side: "after", outdated: false },
  resolved: false,
  messages: [],
  finding
} satisfies ReviewThread
const run = {
  id: "run-1",
  identity,
  profile: null,
  kind: "review",
  completedAt: 900,
  summary: "Recorded verdict",
  explanation: null,
  risks: null,
  focus: null,
  rules: null,
  threads: [line]
} satisfies ReviewRun
const workspace = Schema.decodeUnknownSync(ReviewWorkspace)({
  identity,
  observedAt: 1_000,
  run: { _tag: "Ready", run },
  checks: { _tag: "Unknown" },
  conversations: { _tag: "Unavailable", reason: "not_cached" }
})

it("matches the complete immutable identity including null base and keeps the original run", () => {
  const before = JSON.stringify(workspace)
  const reading = reviewRunReadingForWorkspace(workspace)
  expect(reading._tag).toBe("Current")
  if (reading._tag === "Current") expect(reading.run).toBe(workspace.run._tag === "Ready" ? workspace.run.run : null)
  const withoutBase = Schema.decodeUnknownSync(ReviewWorkspace)({
    ...workspace,
    identity: { ...identity, baseRevision: null },
    run: { _tag: "Ready", run: { ...run, identity: { ...identity, baseRevision: null } } }
  })
  expect(reviewRunReadingForWorkspace(withoutBase)._tag).toBe("Current")
  expect(JSON.stringify(workspace)).toBe(before)
})

it("keeps head, base and revision mismatches explicit even when the head alone is unchanged", () => {
  for (
    const current of [
      { ...identity, headRevision: "head-2" },
      { ...identity, baseRevision: "base-2" },
      { ...identity, revisionId: "revision-2" },
      { ...identity, baseRevision: null }
    ]
  ) {
    const value = { ...workspace, identity: current }
    const before = JSON.stringify(value)
    const reading = reviewRunReadingForWorkspace(value)
    expect(reading._tag).toBe("DifferentRevision")
    if (reading._tag === "DifferentRevision") {
      expect(reading.current).toBe(current)
      expect(reading.run).toBe(value.run._tag === "Ready" ? value.run.run : null)
      expect(reading.run.identity.headRevision).toBe("head-1")
    }
    expect(JSON.stringify(value)).toBe(before)
  }
})

it("preserves missing/unavailable reading identity and reason rather than calling it stale or current", () => {
  for (
    const reading of [
      { _tag: "NotRecorded" },
      { _tag: "Unavailable", reason: "private_path" }
    ] satisfies ReadonlyArray<Exclude<ReviewWorkspace["run"], { readonly _tag: "Ready" }>>
  ) {
    expect(reviewRunReadingForWorkspace({ ...workspace, run: reading })).toBe(reading)
  }
})

it("refuses cross-subject and cross-namespace input at the decoded workspace boundary", () => {
  for (
    const current of [
      { ...identity, subjectId: "other-reference" },
      { ...identity, namespace: "other-namespace" }
    ]
  ) {
    expect(Schema.decodeUnknownResult(ReviewWorkspace)({ ...workspace, identity: current })._tag).toBe("Failure")
  }
})

it("only admits Current readings for current-line placement, keeping other anchors with the parent", () => {
  expectTypeOf<Parameters<typeof currentReviewLineFindings>[0]>().toEqualTypeOf<CurrentReviewRunReading>()
  expectTypeOf<Extract<ReviewRunWorkspaceReading, { readonly _tag: "DifferentRevision" }>>().not.toExtend<
    CurrentReviewRunReading
  >()
  const threads = [
    line,
    { ...line, id: "before", anchor: { ...line.anchor, side: "before" } },
    { ...line, id: "old", anchor: { ...line.anchor, outdated: true } },
    { ...line, id: "file", anchor: { _tag: "File", path: "src/example.ts", outdated: false } },
    { ...line, id: "general", anchor: { _tag: "Unanchored" }, finding: { ...finding, patch: null } },
    { ...line, id: "human", source: "codecommit", finding: null }
  ] satisfies ReadonlyArray<ReviewThread>
  const value = Schema.decodeUnknownSync(ReviewWorkspace)({
    ...workspace,
    run: { _tag: "Ready", run: { ...run, threads } }
  })
  const reading = reviewRunReadingForWorkspace(value)
  expect(reading._tag).toBe("Current")
  if (reading._tag !== "Current") return
  const rows = currentReviewLineFindings(reading)
  expect(rows.map(({ thread }) => thread.id)).toEqual(["line", "before"])
  expect(rows.map(({ anchor }) => anchor.side)).toEqual(["after", "before"])
  expect(rows[0]?.thread).toBe(reading.run.threads[0])
  expect(rows[0]?.finding.patch?.headRevision).toBe(identity.headRevision)
  expect(reading.run.threads).toHaveLength(6)
})
