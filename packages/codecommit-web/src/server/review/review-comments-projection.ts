/** Normalize server-private persisted comments for authenticated review readers. No provider call. @module */
import { type HostCachedComments, HostCommentsReadError } from "@knpkv/codecommit-core/CacheService/HostReads.js"
import { type ReviewAnchor, ReviewConversations, type ReviewMessage, type ReviewThread } from "@knpkv/review"
import { Effect, Schema } from "effect"
import type { CodeDiff } from "../../host-contract.js"
import { codeDisplayAuthor } from "../host-presentation.js"

type CommentThread = HostCachedComments["locations"][number]["comments"][number]

/** Messages are bounded by the public model, and deleted text is not re-emitted from an old cache. */
const messagesOf = Effect.fn("ReviewComments.messages")(function*(thread: CommentThread) {
  const pending = [thread]
  const messages: Array<ReviewMessage> = []
  while (pending.length > 0) {
    const next = pending.pop()
    if (next === undefined) break
    if (messages.length >= 100 || next.root.content.length > 16_384) {
      return yield* new HostCommentsReadError({ reason: "over_limit" })
    }
    const created = yield* Schema.decodeUnknownEffect(Schema.DateFromString)(next.root.creationDate)
    messages.push({
      id: next.root.id,
      author: codeDisplayAuthor(next.root.author),
      createdAt: created.getTime(),
      text: next.root.deleted ? "" : next.root.content,
      deleted: next.root.deleted
    })
    for (let index = next.replies.length - 1; index >= 0; index--) {
      const reply = next.replies[index]
      if (reply !== undefined) pending.push(reply)
    }
  }
  return messages
})

/** Absent provider sides remain file-level rather than inventing a line; old commits stay marked. */
export const reviewConversationsOf = Effect.fn("ReviewComments.project")(
  function*(
    cached: HostCachedComments | null,
    diff: Pick<CodeDiff, "baseCommit" | "headCommit">
  ) {
    if (cached === null) return { _tag: "Unavailable", reason: "not_cached" } satisfies ReviewConversations
    const threads: Array<ReviewThread> = []
    for (const location of cached.locations) {
      const outdated = (location.beforeCommitId !== undefined && location.beforeCommitId !== diff.baseCommit) ||
        (location.afterCommitId !== undefined && location.afterCommitId !== diff.headCommit)
      for (const thread of location.comments) {
        if (threads.length >= 500) return yield* new HostCommentsReadError({ reason: "over_limit" })
        const path = location.filePath ?? thread.root.filePath
        const anchor: ReviewAnchor = path === undefined
          ? { _tag: "Unanchored" }
          : thread.root.lineNumber !== undefined && location.relativeFileVersion !== undefined
          ? {
            _tag: "Line",
            path,
            line: thread.root.lineNumber,
            side: location.relativeFileVersion === "BEFORE" ? "before" : "after",
            outdated
          }
          : { _tag: "File", path, outdated }
        threads.push({
          id: thread.root.id,
          source: "codecommit",
          anchor,
          resolved: false,
          messages: yield* messagesOf(thread),
          finding: null
        })
      }
    }
    return yield* Schema.decodeUnknownEffect(ReviewConversations, { onExcessProperty: "error" })({
      _tag: "Ready",
      observedAt: cached.observedAt,
      threads
    })
  },
  Effect.mapError((failure) =>
    failure._tag === "HostCommentsReadError"
      ? failure :
      new HostCommentsReadError({ reason: "corrupt" })
  )
)
