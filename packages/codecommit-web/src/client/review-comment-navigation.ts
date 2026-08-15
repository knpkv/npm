/** Exact-revision coordinates shared by CodeCommit comments and the diff workbench. @module */

export interface ReviewCommentNavigationTarget {
  readonly afterCommitId: string
  readonly author: string
  readonly beforeCommitId: string
  readonly commentId: string
  readonly content: string
  readonly filePath: string
  readonly lineNumber: number
  readonly side: "after" | "before"
}

export interface ReviewCommentNavigation {
  readonly destination: "comment" | "diff"
  readonly target: ReviewCommentNavigationTarget
}

interface CommentLocationInput {
  readonly afterCommitId?: string | undefined
  readonly beforeCommitId?: string | undefined
  readonly filePath?: string | undefined
  readonly relativeFileVersion?: "AFTER" | "BEFORE" | undefined
}

interface CommentInput {
  readonly author: string
  readonly content: string
  readonly filePath?: string | undefined
  readonly id: string
  readonly lineNumber?: number | undefined
}

/** Return a linkable target only when CodeCommit supplied complete immutable line coordinates. */
export const reviewCommentNavigationTarget = (
  location: CommentLocationInput,
  comment: CommentInput
): ReviewCommentNavigationTarget | null => {
  const filePath = comment.filePath ?? location.filePath
  if (
    filePath === undefined ||
    comment.lineNumber === undefined ||
    !Number.isInteger(comment.lineNumber) ||
    comment.lineNumber < 1 ||
    location.beforeCommitId === undefined ||
    location.afterCommitId === undefined ||
    location.relativeFileVersion === undefined
  ) {
    return null
  }
  return {
    afterCommitId: location.afterCommitId,
    author: comment.author,
    beforeCommitId: location.beforeCommitId,
    commentId: comment.id,
    content: comment.content,
    filePath,
    lineNumber: comment.lineNumber,
    side: location.relativeFileVersion === "AFTER" ? "after" : "before"
  }
}

export const isCommentOnExactRevision = (
  target: ReviewCommentNavigationTarget,
  revision: { readonly baseCommit: string; readonly headCommit: string }
): boolean => target.beforeCommitId === revision.baseCommit && target.afterCommitId === revision.headCommit

export const fileIndexForComment = (
  files: ReadonlyArray<{
    readonly index: number
    readonly path: string
    readonly previousPath: string | null
    readonly status: "added" | "deleted" | "modified" | "renamed"
  }>,
  target: ReviewCommentNavigationTarget
): number | undefined =>
  files.find((file) =>
    target.side === "after"
      ? file.status !== "deleted" && file.path === target.filePath
      : file.status !== "added" && (file.previousPath ?? file.path) === target.filePath
  )?.index
