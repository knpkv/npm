/** Independent comments/conflict notices from export 64. No counts, rows or write actions. @module */
import { StateLabel } from "@knpkv/rly/primitives"
import type { ReviewConversations, ThreadsConflict } from "@knpkv/review"
import type { ReactElement } from "react"
import { ReviewReadAgainButton, type ReviewReadAgainActions } from "./review-read-again-button.js"
import styles from "./review-status-views.module.css"

export interface ReviewThreadsFallbackViewProps extends ReviewReadAgainActions {
  /** Defaults true. False lets an existing thread index own the sole heading and region name. */
  readonly heading?: boolean
  readonly problem: Extract<ReviewConversations, { readonly _tag: "Unavailable" }> | ThreadsConflict
  readonly presentation: "review" | "conversation"
}

const commentProblems = {
  not_cached: { title: "Comments not cached", text: "This host has no saved comments for this pull request." },
  over_limit: { title: "Too many comments to show here", text: "The saved comments exceed this view’s limits." },
  corrupt: { title: "Comments unavailable", text: "The saved comments could not be read on this host." }
} satisfies Readonly<
  Record<
    Extract<ReviewConversations, { readonly _tag: "Unavailable" }>["reason"],
    {
      readonly title: string
      readonly text: string
    }
  >
>

/** Use the same truthful notice on Threads and Conversation; the host owns one retry per read. */
export function ReviewThreadsFallbackView({
  focusTarget,
  heading = true,
  onReadAgain,
  presentation,
  problem
}: ReviewThreadsFallbackViewProps): ReactElement {
  const title = presentation === "review" ? "Threads" : "Conversation"
  const words =
    problem._tag === "ThreadsConflict"
      ? {
          title: "Threads could not be combined",
          text: "The saved review and comments contain conflicting thread records. The diff is still available."
        }
      : commentProblems[problem.reason]
  return (
    <section
      aria-label={heading ? title : undefined}
      className={heading ? styles.threads : styles.embeddedThreads}
      data-review-threads-fallback={problem._tag}
    >
      {heading ? (
        <header className={styles.heading}>
          <h2>{title}</h2>
        </header>
      ) : null}
      <div className={styles.notice} role="status">
        <div className={styles.copy}>
          <StateLabel icon="alert" label={words.title} size="compact" tone="caution" />
          <p>{words.text}</p>
        </div>
        <ReviewReadAgainButton focusTarget={focusTarget} onReadAgain={onReadAgain} />
      </div>
    </section>
  )
}
