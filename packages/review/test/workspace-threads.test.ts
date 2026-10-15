import { Result, Schema } from "effect"
import { describe, expect, it } from "vitest"
import type { ReviewSeverity } from "../src/model.js"
import { reviewWorkspaceThreads } from "../src/workspace-threads.js"
import { ReviewThread, type ReviewWorkspace } from "../src/workspace.js"

const identity = {
  namespace: "codecommit",
  subjectId: "pr-7",
  revisionId: "revision-1",
  baseRevision: "base-1",
  headRevision: "head-1"
}
const finding = (id: string, severity: ReviewSeverity) =>
  Schema.decodeUnknownSync(ReviewThread)({
    id,
    source: "agent",
    resolved: false,
    anchor: { _tag: "Unanchored" },
    messages: [],
    finding: {
      severity,
      axis: null,
      confidence: null,
      claim: id,
      summary: null,
      why: "Evidence",
      recommendation: "Recommendation",
      verification: "Check",
      requirement: null,
      patch: null,
      disposition: { _tag: "Open" }
    }
  })
const conversation = (id: string, source: "codecommit" | "slack" = "codecommit") =>
  Schema.decodeUnknownSync(ReviewThread)({
    id,
    source,
    resolved: false,
    anchor: { _tag: "Unanchored" },
    messages: [],
    finding: null
  })
const workspace = (
  runThreads: ReadonlyArray<ReviewThread>,
  conversations: ReadonlyArray<ReviewThread>
): ReviewWorkspace => ({
  identity,
  observedAt: 1_000,
  checks: { _tag: "Unknown" },
  run: {
    _tag: "Ready",
    run: {
      id: "run-1",
      identity,
      profile: null,
      kind: "review",
      completedAt: 900,
      summary: "Review completed",
      explanation: null,
      risks: null,
      focus: null,
      rules: null,
      threads: runThreads
    }
  },
  conversations: { _tag: "Ready", observedAt: 950, threads: conversations }
})
const success = (reading: ReviewWorkspace) => {
  const result = reviewWorkspaceThreads(reading)
  expect(Result.isSuccess(result)).toBe(true)
  if (Result.isFailure(result)) throw result.failure
  return result.success
}

describe("workspace thread projection", () => {
  it("keeps equal IDs from different sources and conversation input order outside severity groups", () => {
    const agent = finding("same-id", "P1")
    const saved = [conversation("later"), conversation("same-id"), conversation("same-id", "slack")]
    const joined = success(workspace([agent], saved))
    expect(joined.total).toEqual({ _tag: "Exact", n: 4 })
    expect(joined.primary.map(({ thread }) => thread)).toEqual([agent])
    expect(joined.secondary).toEqual([])
    expect(joined.conversations).toEqual(saved)
  })

  it("sorts findings P0-P4 stably and leaves every original thread and anchor untouched", () => {
    const threads = [
      finding("low", "P4"),
      finding("second", "P1"),
      finding("blocking", "P0"),
      finding("third", "P1"),
      finding("medium", "P2"),
      finding("minor", "P3")
    ]
    const reading = workspace(threads, [])
    const before = JSON.stringify(reading)
    const joined = success(reading)
    expect(joined.primary.map(({ thread }) => thread.id)).toEqual(["blocking", "second", "third"])
    expect(joined.secondary.map(({ thread }) => thread.id)).toEqual(["medium", "minor", "low"])
    expect(JSON.stringify(reading)).toBe(before)
    expect(joined.primary[0]?.thread).toBe(threads[2])
    expect(joined.primary[0]?.thread.anchor).toBe(threads[2]?.anchor)
  })

  it("refuses duplicate identities across snapshots instead of dropping one", () => {
    const first = finding("collision", "P1")
    const result = reviewWorkspaceThreads(workspace([first], [{ ...first, messages: [] }]))
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure).toMatchObject({
        _tag: "ThreadsConflict",
        source: "agent",
        id: "collision"
      })
    }
  })

  it("refuses duplicate identities within either snapshot too", () => {
    const agent = finding("collision", "P1")
    const human = conversation("collision")
    for (const reading of [workspace([agent, agent], []), workspace([], [human, human])]) {
      const result = reviewWorkspaceThreads(reading)
      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) expect(result.failure._tag).toBe("ThreadsConflict")
    }
  })

  it("keeps unavailable empty totals as lower bounds and NotRecorded as known absence", () => {
    const empty = workspace([], [])
    expect(success({ ...empty, run: { _tag: "NotRecorded" } }).total).toEqual({ _tag: "Exact", n: 0 })
    for (
      const reading of [
        { ...empty, run: { _tag: "Unavailable", reason: "invalid" } },
        { ...empty, conversations: { _tag: "Unavailable", reason: "not_cached" } },
        { ...empty, run: { _tag: "NotRecorded" }, conversations: { _tag: "Unavailable", reason: "corrupt" } }
      ] satisfies ReadonlyArray<ReviewWorkspace>
    ) {
      expect(success(reading).total).toEqual({ _tag: "AtLeast", n: 0 })
    }
    expect(
      success({
        ...workspace([finding("visible", "P1")], []),
        conversations: { _tag: "Unavailable", reason: "over_limit" }
      }).total
    ).toEqual({ _tag: "AtLeast", n: 1 })
    const human = conversation("retained-comment")
    const humanOnly = success({ ...workspace([], [human]), run: { _tag: "Unavailable", reason: "oversized" } })
    expect(humanOnly.total).toEqual({ _tag: "AtLeast", n: 1 })
    expect(humanOnly.conversations).toEqual([human])
  })

  it("counts totals without treating resolved or dismissed records as absent", () => {
    const resolved = { ...conversation("resolved"), resolved: true }
    const dismissed = finding("dismissed", "P2")
    expect(dismissed.finding).not.toBeNull()
    if (dismissed.finding === null) return
    const reading = workspace([{
      ...dismissed,
      finding: {
        ...dismissed.finding,
        disposition: { _tag: "Dismissed", reason: "wont_fix", note: null }
      }
    }], [resolved])
    const joined = success(reading)
    expect(joined.total).toEqual({ _tag: "Exact", n: 2 })
    expect(joined.secondary).toHaveLength(1)
    expect(joined.conversations).toEqual([resolved])
  })
})
