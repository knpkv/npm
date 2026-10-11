import * as DateUtils from "@knpkv/codecommit-core/DateUtils.js"
import type { CommentThreadJsonEncoded } from "@knpkv/codecommit-core/Domain.js"
import * as AsyncResult from "effect/reactivity/AsyncResult"
import { useMemo } from "react"
import type { PRLifecycleViewProps } from "./pr-detail-view.js"
import { signedOffByOthers } from "./pr-detail-presentation.js"

export type { PRLifecycleViewProps } from "./pr-detail-view.js"

export function PRLifecycleView({ comments, pr }: PRLifecycleViewProps) {
  const timeToMerge = pr.status === "MERGED" ? pr.lastModifiedDate.getTime() - pr.creationDate.getTime() : null

  const { timeToAddressFeedback, timeToFirstReview } = useMemo(() => {
    if (!AsyncResult.isSuccess(comments)) return { timeToFirstReview: null, timeToAddressFeedback: null }
    const allComments: Array<{ author: string; date: Date }> = []
    for (const loc of comments.value) {
      const walk = (threads: ReadonlyArray<CommentThreadJsonEncoded>) => {
        for (const t of threads) {
          allComments.push({ author: t.root.author, date: new Date(t.root.creationDate) })
          walk(t.replies)
        }
      }
      walk(loc.comments)
    }
    allComments.sort((a, b) => a.date.getTime() - b.date.getTime())

    const firstComment = allComments.find((c) => c.author !== pr.author)
    const commentMs = firstComment !== undefined ? firstComment.date.getTime() - pr.creationDate.getTime() : null
    // Approval as review fallback: use lastModifiedDate as proxy for approval time
    const hasNonAuthorApproval = signedOffByOthers(pr)
    const approvalMs = hasNonAuthorApproval ? pr.lastModifiedDate.getTime() - pr.creationDate.getTime() : null
    const ttfr = commentMs != null && approvalMs != null ? Math.min(commentMs, approvalMs) : (commentMs ?? approvalMs)

    const feedbackDeltas: Array<number> = []
    for (let i = 0; i < allComments.length; i++) {
      if (allComments[i]!.author !== pr.author) {
        const reply = allComments.slice(i + 1).find((c) => c.author === pr.author)
        if (reply !== undefined) feedbackDeltas.push(reply.date.getTime() - allComments[i]!.date.getTime())
      }
    }
    const ttaf = feedbackDeltas.length > 0 ? feedbackDeltas.reduce((a, b) => a + b, 0) / feedbackDeltas.length : null

    return { timeToFirstReview: ttfr, timeToAddressFeedback: ttaf }
  }, [comments, pr])

  const hasAny = timeToMerge != null || timeToFirstReview != null || timeToAddressFeedback != null
  if (!hasAny) return null

  return (
    <>
      {timeToMerge != null && (
        <>
          <dt>Time to merge</dt>
          <dd>{DateUtils.formatDuration(timeToMerge)}</dd>
        </>
      )}
      {timeToFirstReview != null && (
        <>
          <dt>Time to first review</dt>
          <dd>{DateUtils.formatDuration(timeToFirstReview)}</dd>
        </>
      )}
      {timeToAddressFeedback != null && (
        <>
          <dt>Time to address feedback</dt>
          <dd>{DateUtils.formatDuration(timeToAddressFeedback)}</dd>
        </>
      )}
    </>
  )
}
