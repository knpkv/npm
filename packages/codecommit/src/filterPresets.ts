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

/**
 * Robust identity comparison for the `mine` preset.
 *
 * Both sides normally arrive already normalised by codecommit-core's
 * `normalizeAuthor` (ARN → trailing `/`-segment), so the happy path is a plain
 * equality. Under cross-account SSO / assumed-role setups the two strings can
 * still diverge — e.g. one side is a full ARN or `AWSReservedSSO_<perm>_<id>/<user>`
 * form while the other is the bare username, or they differ only in case. This
 * is a SUPERSET of exact match: it still matches when the strings are equal, and
 * additionally matches when, after case-folding and reducing each side to its
 * final `/`- or `:`-segment (the username), the username segments are equal.
 * It deliberately anchors on the username segment so unrelated users never match.
 */
export const identityMatches = (callerUsername: string, prAuthor: string): boolean => {
  const norm = (s: string) => s.trim().toLowerCase()
  const tail = (s: string) => {
    const segments = norm(s).split(/[/:]/).filter((seg) => seg.length > 0)
    return segments[segments.length - 1] ?? ""
  }
  const a = norm(callerUsername)
  const b = norm(prAuthor)
  if (a === "" || b === "") return false
  if (a === b) return true
  const ta = tail(callerUsername)
  const tb = tail(prAuthor)
  return ta !== "" && ta === tb
}

/** Match a PR against a named filter preset. `now` and the caller map are injected for testability. */
export const matchesPreset = (
  preset: FilterPreset,
  pr: PullRequest,
  callerByProfile: Map<string, string>,
  now: Date
): boolean => {
  switch (preset) {
    case "mine": {
      const me = callerByProfile.get(pr.account.profile)
      return !!me && identityMatches(me, pr.author)
    }
    // Note: needs-my-review delegates to core's `needsMyReview`, which compares the
    // already-normalised caller username against approval-pool members by exact value;
    // SSO/ARN reconciliation for that path would belong in codecommit-core, not here.
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
