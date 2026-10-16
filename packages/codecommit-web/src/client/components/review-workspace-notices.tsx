/** One retry per host read, including simultaneous history/comments failure. Export 66. @module */
import { reviewWorkspaceThreads, type ReviewWorkspace } from "@knpkv/review"
import { Result } from "effect"
import type { ReactElement } from "react"
import { ReviewReadAgainButton, type ReviewReadAgainActions } from "./review-read-again-button.js"
import { ReviewRunFallbackView } from "./review-run-fallback-view.js"
import { ReviewThreadsFallbackView } from "./review-threads-fallback-view.js"

export interface ReviewWorkspaceNoticesProps extends ReviewReadAgainActions {
  readonly workspace: ReviewWorkspace
  readonly presentation: "review" | "conversation"
}

/**
 * Ready summary, diff and rows remain with their own read views. A conflict replaces only the thread
 * list. When that list owns a retry, the independent missing-history notice is message-only.
 * Conversation keeps unreadable history visible and gives its single retry to the discussion feed.
 */
export function ReviewWorkspaceNotices({
  focusTarget,
  onReadAgain,
  presentation,
  workspace
}: ReviewWorkspaceNoticesProps): ReactElement {
  const joined = reviewWorkspaceThreads(workspace)
  const problem = Result.isFailure(joined)
    ? joined.failure
    : workspace.conversations._tag === "Unavailable"
      ? workspace.conversations
      : null
  const readAgain = { focusTarget, onReadAgain }
  return (
    <>
      {workspace.run._tag === "Unavailable" || (presentation === "review" && workspace.run._tag === "NotRecorded") ? (
        <ReviewRunFallbackView
          conversations={workspace.conversations}
          reading={workspace.run}
          readAgain={presentation === "review" && problem === null ? readAgain : null}
        />
      ) : null}
      {presentation === "conversation" && workspace.run._tag === "Unavailable" && problem === null ? (
        <ReviewReadAgainButton focusTarget={focusTarget} onReadAgain={onReadAgain} />
      ) : null}
      {problem !== null ? (
        <ReviewThreadsFallbackView
          focusTarget={focusTarget}
          onReadAgain={onReadAgain}
          presentation={presentation}
          problem={problem}
        />
      ) : null}
    </>
  )
}
