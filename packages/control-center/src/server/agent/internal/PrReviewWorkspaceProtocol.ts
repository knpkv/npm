/** Shared ownership markers for private PR-review workspace artifacts. @module */

export const PR_REVIEW_TREE_PREFIX = ".pr-review-tree-"
export const PR_REVIEW_GIT_PREFIX = ".pr-review-git-"

export const PR_REVIEW_SANDBOX_PREFIXES: ReadonlyArray<string> = [
  PR_REVIEW_TREE_PREFIX,
  PR_REVIEW_GIT_PREFIX
]
