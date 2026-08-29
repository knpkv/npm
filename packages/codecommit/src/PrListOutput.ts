/**
 * The four-line block `pr list` prints per pull request.
 *
 * Both list paths — single account and cross-account preset — render the same
 * entry and decorate only the identity line, but they decorate opposite ends of
 * it: the preset path appends which account answered, and the single-account
 * `--all` path prepends the status, since a mixed OPEN/CLOSED listing is
 * ambiguous without it. Keeping both here means the two cannot drift, and the
 * format can be asserted without capturing stdout.
 *
 * @category Rendering
 * @module
 */
import type { Domain } from "@knpkv/codecommit-core"

/** `approved`/`mergeable` decoration, in the fixed order the list has always used. */
export const renderFlags = (pr: Domain.PullRequest): string =>
  [
    pr.isApproved ? "approved" : "",
    pr.isMergeable ? "mergeable" : "conflicts"
  ].filter(Boolean).join(" ")

/**
 * One pull request as the lines to print, trailing blank line included.
 *
 * `prefix` and `suffix` bracket the repository name on the identity line; both
 * default to empty so a caller states only the end it decorates.
 */
export const renderPullRequestEntry = (
  pr: Domain.PullRequest,
  decoration?: { readonly prefix?: string; readonly suffix?: string }
): ReadonlyArray<string> => [
  `${pr.id}  ${decoration?.prefix ?? ""}${pr.repositoryName}${decoration?.suffix ?? ""}`,
  `    ${pr.title}`,
  `    ${pr.sourceBranch} -> ${pr.destinationBranch}`,
  `    by ${pr.author}  ${renderFlags(pr)}`,
  ""
]

/** Identity-line suffix for the cross-account preset path: which account answered. */
export const accountSuffix = (pr: Domain.PullRequest): string => `  [${pr.account.profile}/${pr.account.region}]`

/** Identity-line prefix for the single-account path, used only when statuses are mixed. */
export const statusPrefix = (pr: Domain.PullRequest, includeStatus: boolean): string =>
  includeStatus ? `[${pr.status}] ` : ""
