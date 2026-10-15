import { expect, it } from "@effect/vitest"
import type { HostCachedComments } from "@knpkv/codecommit-core/CacheService/HostReads.js"
import { Effect } from "effect"
import { reviewConversationsOf } from "../src/server/review/review-comments-projection.js"

const root = {
  id: "comment",
  author: "Reviewer",
  content: "Check the storage key",
  creationDate: "2026-10-13T12:00:00Z",
  deleted: false
}
const diff = { baseCommit: "base-one", headCommit: "head-one" }
const cached: HostCachedComments = {
  observedAt: 1_000,
  locations: [{
    filePath: "src/review.ts",
    beforeCommitId: "base-one",
    afterCommitId: "head-one",
    relativeFileVersion: "AFTER",
    comments: [{
      root: { ...root, lineNumber: 42 },
      replies: [{ root: { ...root, id: "reply", author: "Author" }, replies: [] }]
    }]
  }]
}

it.effect("keeps missing conversations unknown and cached-empty ones explicitly empty", () =>
  Effect.gen(function*() {
    expect(yield* reviewConversationsOf(null, diff)).toEqual({ _tag: "Unavailable", reason: "not_cached" })
    expect(yield* reviewConversationsOf({ observedAt: 1_000, locations: [] }, diff)).toEqual({
      _tag: "Ready",
      observedAt: 1_000,
      threads: []
    })
  }))

it.effect("keeps cached capture time, comment time, side and reply identity separate", () =>
  Effect.gen(function*() {
    const result = yield* reviewConversationsOf(cached, diff)
    expect(result._tag).toBe("Ready")
    if (result._tag !== "Ready") return
    expect(result.observedAt).toBe(1_000)
    expect(result.threads[0]?.anchor).toEqual({
      _tag: "Line",
      path: "src/review.ts",
      line: 42,
      side: "after",
      outdated: false
    })
    expect(result.threads[0]?.messages.map((message) => message.id)).toEqual(["comment", "reply"])
    expect(result.threads[0]?.messages[0]?.createdAt).toBe(1791892800000)
    expect(result.threads[0]?.finding).toBeNull()
  }))

it.effect("marks old commit anchors and never invents an absent provider side", () =>
  Effect.gen(function*() {
    const result = yield* reviewConversationsOf(cached, { ...diff, headCommit: "head-two" })
    if (result._tag !== "Ready") return
    expect(result.threads[0]?.anchor).toMatchObject({ outdated: true })
    const file = yield* reviewConversationsOf({
      observedAt: 1_000,
      locations: [{ filePath: "src/review.ts", comments: [{ root: { ...root, lineNumber: 42 }, replies: [] }] }]
    }, diff)
    expect(file._tag).toBe("Ready")
    if (file._tag === "Ready") {
      expect(file.threads[0]?.anchor).toEqual({ _tag: "File", path: "src/review.ts", outdated: false })
    }
  }))

it.effect("suppresses deleted root text but preserves live replies and normalizes provider authors", () =>
  Effect.gen(function*() {
    const result = yield* reviewConversationsOf({
      ...cached,
      locations: [{
        comments: [{
          root: { ...root, deleted: true, author: "arn:unknown-private-locator" },
          replies: [
            { root: { ...root, id: "reply-one", content: "First live reply" }, replies: [] },
            { root: { ...root, id: "reply-two", content: "Second live reply" }, replies: [] }
          ]
        }]
      }]
    }, diff)
    expect(result._tag).toBe("Ready")
    if (result._tag !== "Ready") return
    expect(result.threads[0]?.messages).toEqual([
      { id: "comment", author: "Unknown author", createdAt: 1791892800000, text: "", deleted: true },
      { id: "reply-one", author: "Reviewer", createdAt: 1791892800000, text: "First live reply", deleted: false },
      { id: "reply-two", author: "Reviewer", createdAt: 1791892800000, text: "Second live reply", deleted: false }
    ])
    expect(JSON.stringify(result)).not.toContain("arn:")
    expect(JSON.stringify(result)).not.toContain("Check the storage key")
  }))

it.effect("reports oversized normalized threads separately from malformed timestamps", () =>
  Effect.gen(function*() {
    const large = yield* Effect.result(reviewConversationsOf({
      observedAt: 1_000,
      locations: [{
        comments: [{
          root,
          replies: Array.from({ length: 100 }, (_, index) => ({ root: { ...root, id: `reply-${index}` }, replies: [] }))
        }]
      }]
    }, diff))
    expect(large._tag).toBe("Failure")
    if (large._tag === "Failure") expect(large.failure.reason).toBe("over_limit")
    const corrupt = yield* Effect.result(
      reviewConversationsOf({
        observedAt: 1_000,
        locations: [{ comments: [{ root: { ...root, creationDate: "invalid" }, replies: [] }] }]
      }, diff)
    )
    expect(corrupt._tag).toBe("Failure")
    if (corrupt._tag === "Failure") expect(corrupt.failure.reason).toBe("corrupt")
  }))
