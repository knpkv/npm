/**
 * The pull requests a queue-shaped view may show.
 *
 * One seam for the whole browser app: the PR queue and its filter sidebar go
 * through here, while URL-addressable views — the PR detail route, the Relay
 * dock's locator lookup, the stats lists — resolve against the whole cached
 * list, because a URL may name a pull request the queue hides.
 *
 * @module
 */
import type { PullRequest } from "@knpkv/codecommit-core/Domain.js"
import { listedForEnabledAccounts } from "@knpkv/codecommit-core/Domain.js"

export interface QueueState {
  readonly pullRequests: ReadonlyArray<PullRequest>
  /**
   * Accounts switched on, as the server read them from the persisted config.
   * Absent means the server could not read it, and the queue then lists
   * everything rather than blanking. Never derive this from `accounts`: that is
   * a profile-detection snapshot and is empty without a readable `~/.aws/config`.
   */
  readonly enabledProfiles?: ReadonlyArray<string> | undefined
}

export const queuePullRequests = (state: QueueState): ReadonlyArray<PullRequest> =>
  listedForEnabledAccounts(
    state.pullRequests,
    state.enabledProfiles === undefined ? undefined : new Set(state.enabledProfiles)
  )
