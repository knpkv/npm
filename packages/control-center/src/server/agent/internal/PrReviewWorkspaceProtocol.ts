/** Shared ownership markers for private PR-review workspace artifacts. @module */

export const PR_REVIEW_TREE_PREFIX = ".pr-review-tree-"
export const PR_REVIEW_GIT_PREFIX = ".pr-review-git-"

export const PR_REVIEW_SANDBOX_PREFIXES: ReadonlyArray<string> = [
  PR_REVIEW_TREE_PREFIX,
  PR_REVIEW_GIT_PREFIX
]

/** Lowercase Git-config key classes that can redirect or authenticate repository access. */
export const PR_REVIEW_AUTHORITY_CONFIG_PATTERN =
  "^(credential\\.|http\\.(.*\\.)?extraheader$|remote\\.|url\\..*\\.(insteadof|pushinsteadof)$|core\\.sshcommand$|include\\.path$|includeif\\..*\\.path$)"

const authorityConfigurationKey = new RegExp(
  PR_REVIEW_AUTHORITY_CONFIG_PATTERN,
  "u"
)

/** Classify a Git-config key after applying Git's case-insensitive key semantics. */
export const isPrReviewAuthorityConfigKey = (key: string): boolean => authorityConfigurationKey.test(key.toLowerCase())
