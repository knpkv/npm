/**
 * Cross-account `--filter` presets for `pr list`.
 *
 * Pure predicates shared by the CLI fan-out path. Kept in a side-effect-free
 * module (separate from `bin.ts`, which runs the CLI on import) so they can be
 * unit-tested directly.
 *
 * @module
 */
import { needsMyReview, type PullRequest } from "@knpkv/codecommit-core/Domain.js"
import { Option } from "effect"

/** Named presets that fan out across all enabled accounts. */
export const FILTER_PRESETS = ["mine", "needs-my-review", "stale", "conflicting"] as const
export type FilterPreset = typeof FILTER_PRESETS[number]

/** Inactivity threshold (in days) for the `stale` preset. */
export const STALE_DAYS = 7

/**
 * Shared repo/author predicate, used by both the fan-out filter path and the
 * single-account path so the two stay in sync.
 */
export const matchesRepoAuthor = (
  pr: PullRequest,
  repo: Option.Option<string>,
  author: Option.Option<string>
): boolean => {
  if (Option.isSome(repo) && pr.repositoryName !== repo.value) return false
  if (Option.isSome(author) && pr.author !== author.value) return false
  return true
}

/** Match a PR against a named filter preset. `now` and the caller map are injected for testability. */
export const matchesPreset = (
  preset: FilterPreset,
  pr: PullRequest,
  callerByProfile: Map<string, string>,
  now: Date
): boolean => {
  switch (preset) {
    // TODO(review #35): under cross-account SSO the STS caller username (from
    // getCallerIdentity) may not equal CodeCommit's pr.author identity string;
    // deferred pending confirmation of the author identity format in use.
    case "mine": {
      const me = callerByProfile.get(pr.account.profile)
      return !!me && pr.author === me
    }
    case "needs-my-review": {
      const me = callerByProfile.get(pr.account.profile)
      return needsMyReview(pr, me)
    }
    case "stale": {
      const daysSince = (now.getTime() - pr.lastModifiedDate.getTime()) / 86_400_000
      return daysSince > STALE_DAYS
    }
    case "conflicting":
      return !pr.isMergeable
  }
}
