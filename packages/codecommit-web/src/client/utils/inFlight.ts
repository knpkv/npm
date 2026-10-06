/**
 * One in-flight request per key.
 *
 * - `share`: while a request for the key is pending, return that same promise instead of starting
 *   another, so overlapping triggers (a mount refresh, the Refresh button) cannot cancel each other.
 * - `fresh`: after a change, a pending request may have read the old state, so wait for it and then
 *   start a new one. Later `share` asks join the fresh request.
 *
 * Once a request settles, the next ask starts afresh.
 */
export const makeInFlight = <A>() => {
  const pending = new Map<string, Promise<A>>()
  const track = (key: string, started: Promise<A>): Promise<A> => {
    pending.set(key, started)
    void started.finally(() => {
      if (pending.get(key) === started) pending.delete(key)
    }).catch(() => {})
    return started
  }
  return {
    share: (key: string, run: () => Promise<A>): Promise<A> => pending.get(key) ?? track(key, run()),
    fresh: (key: string, run: () => Promise<A>): Promise<A> => {
      const prior = pending.get(key)
      return track(key, prior === undefined ? run() : prior.then(run, run))
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
