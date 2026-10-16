/** Recorded messages only; thread anchors and source remain with the parent. @module */
import type { ReviewMessage } from "@knpkv/review"
import type { DateTime } from "effect"
import type { ReactElement } from "react"
import Markdown from "react-markdown"
import rehypeSanitize from "rehype-sanitize"
import remarkGfm from "remark-gfm"
import { reviewReadingTime } from "../review-reading-time.js"
import styles from "./review-thread-messages-view.module.css"

export interface ReviewThreadMessagesViewProps {
  readonly messages: ReadonlyArray<ReviewMessage>
  /** Validated named viewer zone; absent uses the browser zone. */
  readonly timeZone?: DateTime.TimeZone.Named | undefined
}

/** Deleted text never reappears; live replies keep their recorded order, authors and absolute times. */
export function ReviewThreadMessagesView({ messages, timeZone }: ReviewThreadMessagesViewProps): ReactElement | null {
  if (messages.length === 0) return null
  return (
    <ol className={styles.messages}>
      {messages.map((message, index) => {
        const time = reviewReadingTime(message.createdAt, timeZone)
        return (
          <li className={styles.message} data-review-message-id={message.id} key={JSON.stringify([message.id, index])}>
            <div className={styles.meta}>
              <strong>{message.author}</strong>
              <time dateTime={time.iso} title={time.full}>
                {time.clock}
              </time>
            </div>
            {message.deleted ? (
              <p className={styles.deleted} data-deleted="true">
                Comment deleted
              </p>
            ) : (
              <div className={styles.body}>
                <Markdown rehypePlugins={[rehypeSanitize]} remarkPlugins={[remarkGfm]}>
                  {message.text}
                </Markdown>
              </div>
            )}
          </li>
        )
      })}
    </ol>
  )
}
