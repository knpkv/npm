/**
 * One in-flight request per key.
 *
 * - `share`: while a request for the key is pending, return that same promise instead of starting
 *   another, so overlapping triggers (a mount refresh, the Refresh button) cannot cancel each other.
 * - `fresh`: after a change, a pending request may have read the old state, so wait for it and then
 *   start a new one. Asks made while that new read waits to start join it, since it begins after all
 *   of them; polling during one slow request therefore queues one read, not one per poll.
 *
 * Once a request settles, the next ask starts afresh.
 */
export const makeInFlight = <A>() => {
  const pending = new Map<string, Promise<A>>()
  // A `fresh` read queued behind a pending request, until it starts.
  const waiting = new Map<string, Promise<A>>()
  const start = (key: string, run: () => Promise<A>): Promise<A> => {
    const started = run()
    pending.set(key, started)
    void started.finally(() => {
      if (pending.get(key) === started) pending.delete(key)
    }).catch(() => {})
    return started
  }
  return {
    share: (key: string, run: () => Promise<A>): Promise<A> => waiting.get(key) ?? pending.get(key) ?? start(key, run),
    fresh: (key: string, run: () => Promise<A>): Promise<A> => {
      const queued = waiting.get(key)
      if (queued !== undefined) return queued
      const prior = pending.get(key)
      if (prior === undefined) return start(key, run)
      const begin = () => {
        waiting.delete(key)
        return start(key, run)
      }
      const next = prior.then(begin, begin)
      waiting.set(key, next)
      return next
    }
  }
}

/**
 * The in-flight key for refreshing one pull request, from the route that names it: account, PR id and
 * the URL's repository and region. These stay the same while the page shows the PR, though the loaded
 * PR later replaces the account id and coordinates a request uses. Two accounts' PRs with the same
 * number, repository and region never share a key.
 */
export const pullRequestRefreshKey = (
  routeAccount: string | undefined,
  pullRequestId: string,
  repositoryName: string | undefined,
  region: string | undefined
): string => [routeAccount ?? "", pullRequestId, repositoryName ?? "", region ?? ""].join("\u0000")
