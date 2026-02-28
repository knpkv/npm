/**
 * Diff logic for generating persistent notifications from state changes.
 *
 * @module
 */
import type { CommentThread, PRCommentLocation } from "../Domain.js"

export interface NewNotification {
  readonly pullRequestId: string
  readonly awsAccountId: string
  readonly type: string
  readonly message: string
  readonly title?: string
  readonly profile?: string
}

export interface DiffablePR {
  readonly id: string
  readonly title: string
  readonly description?: string | null | undefined
  readonly repositoryName: string
  readonly accountProfile: string
  readonly status: string
  readonly isApproved: boolean | number
  readonly isMergeable: boolean | number
  readonly commentCount?: number | null | undefined
}

export const diffPR = (
  cached: DiffablePR,
  fresh: DiffablePR,
  awsAccountId: string
): Array<NewNotification> => {
  const base = { pullRequestId: fresh.id, awsAccountId, profile: fresh.accountProfile }
  const label = `#${fresh.id} ${fresh.title} (${fresh.repositoryName})`
  const notifications: Array<NewNotification> = []

  // Skip comment diff when cached count is null/undefined (first fetch — no baseline to compare)
  if (cached.commentCount != null) {
    const freshComments = fresh.commentCount ?? 0
    if (freshComments > cached.commentCount) {
      notifications.push({ ...base, type: "new_comment", title: fresh.title, message: `New comments on ${label}` })
    }
  }

  if (Boolean(fresh.isApproved) !== Boolean(cached.isApproved)) {
    notifications.push({
      ...base,
      type: "approval_changed",
      title: fresh.title,
      message: `Approval ${fresh.isApproved ? "granted" : "revoked"} on ${label}`
    })
  }

  if (Boolean(fresh.isMergeable) !== Boolean(cached.isMergeable)) {
    notifications.push({
      ...base,
      type: "merge_changed",
      title: fresh.title,
      message: `${label} is ${fresh.isMergeable ? "now mergeable" : "no longer mergeable"}`
    })
  }

  if (fresh.title !== cached.title) {
    notifications.push({ ...base, type: "title_changed", title: fresh.title, message: `Title changed on ${label}` })
  }

  if (fresh.description !== cached.description) {
    notifications.push({
      ...base,
      type: "description_changed",
      title: fresh.title,
      message: `Description updated on ${label}`
    })
  }

  if (fresh.status !== cached.status) {
    // CodeCommit sets isMergeable=false after merge, so CLOSED+!isMergeable = merged
    if (fresh.status === "CLOSED" && !fresh.isMergeable) {
      notifications.push({ ...base, type: "pr_merged", title: fresh.title, message: `${label} was merged` })
    } else if (fresh.status === "CLOSED") {
      notifications.push({ ...base, type: "pr_closed", title: fresh.title, message: `${label} was closed` })
    } else if (fresh.status === "OPEN" && cached.status === "CLOSED") {
      notifications.push({ ...base, type: "pr_reopened", title: fresh.title, message: `${label} was reopened` })
    }
  }

  return notifications
}

const flattenThreadComments = (thread: CommentThread): Array<{ id: string; content: string; deleted: boolean }> => {
  const result: Array<{ id: string; content: string; deleted: boolean }> = [
    { id: thread.root.id, content: thread.root.content, deleted: thread.root.deleted }
  ]
  for (const reply of thread.replies) {
    for (const item of flattenThreadComments(reply)) {
      result.push(item)
    }
  }
  return result
}

const flattenLocations = (locations: ReadonlyArray<PRCommentLocation>) => {
  const all: Array<{ id: string; content: string; deleted: boolean }> = []
  for (const loc of locations) {
    for (const thread of loc.comments) {
      for (const item of flattenThreadComments(thread)) {
        all.push(item)
      }
    }
  }
  return all
}

export const diffComments = (
  cached: ReadonlyArray<PRCommentLocation>,
  fresh: ReadonlyArray<PRCommentLocation>,
  pullRequestId: string,
  awsAccountId: string
): Array<NewNotification> => {
  const base = { pullRequestId, awsAccountId }
  const cachedFlat = flattenLocations(cached)
  const freshFlat = flattenLocations(fresh)
  const cachedMap = new Map(cachedFlat.map((c) => [c.id, c]))
  const cachedIds = new Set(cachedFlat.map((c) => c.id))
  const notifications: Array<NewNotification> = []

  let hasNew = false
  let hasEdited = false
  let hasDeleted = false

  for (const f of freshFlat) {
    if (!cachedIds.has(f.id) && !hasNew) {
      notifications.push({ ...base, type: "new_comment", message: `New comment on #${pullRequestId}` })
      hasNew = true
    }
    const old = cachedMap.get(f.id)
    if (old && old.content !== f.content && !f.deleted && !hasEdited) {
      notifications.push({ ...base, type: "comment_edited", message: `Comment edited on #${pullRequestId}` })
      hasEdited = true
    }
    if (old && !old.deleted && f.deleted && !hasDeleted) {
      notifications.push({ ...base, type: "comment_deleted", message: `Comment deleted on #${pullRequestId}` })
      hasDeleted = true
    }
  }

  return notifications
}
