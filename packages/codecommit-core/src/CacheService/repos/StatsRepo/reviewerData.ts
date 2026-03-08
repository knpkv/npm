/**
 * @module StatsRepo/reviewerData
 *
 * Hybrid SQL + in-memory computation for reviewer/approver analytics.
 * Fetches PR metadata and comment JSON, then computes reviewer rankings,
 * approval counts, and time-to-first-review metrics in-memory because
 * the nested comment structure can't be flattened in SQL.
 *
 * @category CacheService
 */
import type * as SqlClient from "@effect/sql/SqlClient"
import { Effect, Schema } from "effect"
import {
  cacheError,
  type CommentRow,
  extractComments,
  type Filters,
  LocationsFromJson,
  type PRForReviewRow,
  whereFilters
} from "./internal.js"

export const reviewerData = (sql: SqlClient.SqlClient) => (weekStart: string, weekEnd: string, filters: Filters) => {
  const f = whereFilters(sql, filters)
  const fJoin = whereFilters(sql, filters, "p")
  return Effect.all({
    prs: sql<PRForReviewRow>`
        SELECT id, title, author, aws_account_id, repository_name, creation_date, closed_at,
          COALESCE(closed_at, last_modified_date) as last_modified_date, is_approved, status, merged_by, approved_by
        FROM pull_requests
        WHERE COALESCE(closed_at, last_modified_date) >= ${weekStart} AND COALESCE(closed_at, last_modified_date) < ${weekEnd}
          AND status != 'CLOSED'
          ${f.repo} ${f.author} ${f.account}
      `,
    comments: sql<CommentRow>`
        SELECT c.pull_request_id, c.aws_account_id, c.locations_json
        FROM pr_comments c
        INNER JOIN pull_requests p ON p.id = c.pull_request_id AND p.aws_account_id = c.aws_account_id
        WHERE COALESCE(p.closed_at, p.last_modified_date) >= ${weekStart} AND COALESCE(p.closed_at, p.last_modified_date) < ${weekEnd}
          AND p.status != 'CLOSED'
          ${fJoin.repo} ${fJoin.author} ${fJoin.account}
      `
  }).pipe(
    Effect.flatMap(({ comments, prs }) =>
      Effect.gen(function*() {
        const prAuthors = new Map(
          prs.map((p) => [
            `${p.awsAccountId}:${p.id}`,
            {
              id: p.id,
              title: p.title,
              author: p.author,
              repositoryName: p.repositoryName,
              awsAccountId: p.awsAccountId,
              creationDate: new Date(p.creationDate),
              closedAt: p.closedAt ? new Date(p.closedAt) : null,
              lastModifiedDate: new Date(p.lastModifiedDate),
              isApproved: p.isApproved === 1,
              isMerged: p.status === "MERGED",
              mergedBy: p.mergedBy,
              approvedBy: p.approvedBy
                ? p.approvedBy.split(",").map((s) => s.trim()).filter((s) => s && s !== p.author)
                : []
            }
          ])
        )

        // Top approvers — from approved_by column (comma-separated names)
        const approverCounts = new Map<string, number>()
        for (const p of prs) {
          if (p.approvedBy) {
            for (const name of p.approvedBy.split(",")) {
              const trimmed = name.trim()
              if (trimmed && trimmed !== p.author) {
                approverCounts.set(trimmed, (approverCounts.get(trimmed) ?? 0) + 1)
              }
            }
          }
        }

        type Detail = {
          prId: string
          prTitle: string
          author: string
          repositoryName: string
          awsAccountId: string
          durationMs: number
          fromLabel: string
          toLabel: string
        }

        const reviewerCounts = new Map<string, number>()
        const firstReviewDeltas: Array<number> = []
        const firstReviewDetails: Array<Detail> = []
        const feedbackDeltas: Array<number> = []
        const feedbackDetails: Array<Detail> = []
        const prsWithCommentReview = new Set<string>()

        const wsMs = new Date(weekStart).getTime()
        const weMs = new Date(weekEnd).getTime()
        const fmtTs = (d: Date) => d.toISOString().slice(0, 16).replace("T", " ")

        for (const row of comments) {
          const key = `${row.awsAccountId}:${row.pullRequestId}`
          const prInfo = prAuthors.get(key)
          if (!prInfo) continue

          const parsed = yield* Schema.decodeUnknown(LocationsFromJson)(row.locationsJson).pipe(
            Effect.catchAll(() => Effect.succeed([]))
          )
          const allComments = extractComments(parsed)
          const sorted = [...allComments].sort((a, b) => a.creationDate.getTime() - b.creationDate.getTime())

          // Filter to week range
          const inWeek = sorted.filter((c) => c.creationDate.getTime() >= wsMs && c.creationDate.getTime() < weMs)

          // Top reviewers — comments in this week (exclude self-reviews)
          for (const c of inWeek) {
            if (c.author !== prInfo.author) {
              reviewerCounts.set(c.author, (reviewerCounts.get(c.author) ?? 0) + 1)
            }
          }

          // (mergedBy-based approver counting moved above comment loop)

          // Time to first review (comment action)
          const firstReview = sorted.find((c) => c.author !== prInfo.author)
          if (firstReview) {
            prsWithCommentReview.add(key)
            const durationMs = firstReview.creationDate.getTime() - prInfo.creationDate.getTime()
            firstReviewDeltas.push(durationMs)
            firstReviewDetails.push({
              prId: prInfo.id,
              prTitle: prInfo.title,
              author: prInfo.author,
              repositoryName: prInfo.repositoryName,
              awsAccountId: prInfo.awsAccountId,
              durationMs,
              fromLabel: fmtTs(prInfo.creationDate),
              toLabel: `${fmtTs(firstReview.creationDate)} (${firstReview.author})`
            })
          }

          // Time to address feedback (review comment → next author reply)
          const prFeedbackDeltas: Array<number> = []
          let firstFeedbackFrom: Date | undefined
          let lastFeedbackTo: Date | undefined
          for (let i = 0; i < sorted.length; i++) {
            if (sorted[i]!.author !== prInfo.author) {
              const nextAuthorReply = sorted.slice(i + 1).find((c) => c.author === prInfo.author)
              if (nextAuthorReply) {
                const dMs = nextAuthorReply.creationDate.getTime() - sorted[i]!.creationDate.getTime()
                feedbackDeltas.push(dMs)
                prFeedbackDeltas.push(dMs)
                if (!firstFeedbackFrom) firstFeedbackFrom = sorted[i]!.creationDate
                lastFeedbackTo = nextAuthorReply.creationDate
              }
            }
          }
          if (prFeedbackDeltas.length > 0) {
            const avgMs = prFeedbackDeltas.reduce((a, b) => a + b, 0) / prFeedbackDeltas.length
            feedbackDetails.push({
              prId: prInfo.id,
              prTitle: prInfo.title,
              author: prInfo.author,
              repositoryName: prInfo.repositoryName,
              awsAccountId: prInfo.awsAccountId,
              durationMs: avgMs,
              fromLabel: `${fmtTs(firstFeedbackFrom!)} (${prFeedbackDeltas.length} rounds)`,
              toLabel: fmtTs(lastFeedbackTo!)
            })
          }
        }

        // Approve-only first review: PRs approved by non-author but without non-author comments
        for (const [key, prInfo] of prAuthors) {
          if (prsWithCommentReview.has(key)) continue
          if (prInfo.approvedBy.length === 0) continue
          // Use closed_at (merge time) as proxy for approval time
          const reviewDate = prInfo.closedAt ?? prInfo.lastModifiedDate
          const durationMs = reviewDate.getTime() - prInfo.creationDate.getTime()
          if (durationMs <= 0) continue
          firstReviewDeltas.push(durationMs)
          firstReviewDetails.push({
            prId: prInfo.id,
            prTitle: prInfo.title,
            author: prInfo.author,
            repositoryName: prInfo.repositoryName,
            awsAccountId: prInfo.awsAccountId,
            durationMs,
            fromLabel: fmtTs(prInfo.creationDate),
            toLabel: `${fmtTs(reviewDate)} (approved: ${prInfo.approvedBy[0]!})`
          })
        }

        const topReviewers = [...reviewerCounts.entries()]
          .map(([author, commentCount]) => ({ author, commentCount }))
          .sort((a, b) => b.commentCount - a.commentCount)
          .slice(0, 10)

        const topApprovers = [...approverCounts.entries()]
          .map(([author, approvalCount]) => ({ author, approvalCount }))
          .sort((a, b) => b.approvalCount - a.approvalCount)
          .slice(0, 10)

        const avg = (arr: Array<number>) => arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : null

        return {
          topReviewers,
          topApprovers,
          avgTimeToFirstReview: avg(firstReviewDeltas),
          avgTimeToMerge: null as number | null, // computed separately from PR dates
          avgTimeToAddressFeedback: avg(feedbackDeltas),
          firstReviewDetails,
          feedbackDetails
        }
      }).pipe(Effect.withSpan("StatsRepo.reviewerData.compute"))
    ),
    cacheError("reviewerData")
  )
}
