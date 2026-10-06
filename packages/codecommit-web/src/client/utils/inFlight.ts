/**
 * Share one in-flight request per key. While a request for a key is pending, asking again returns the
 * same promise instead of starting another, so overlapping triggers (a mount refresh, an approval-rule
 * change, the Refresh button) cannot cancel each other. Once it settles, the next ask starts fresh.
 */
export const makeInFlight = <A>() => {
  const pending = new Map<string, Promise<A>>()
  return (key: string, run: () => Promise<A>): Promise<A> => {
    const existing = pending.get(key)
    if (existing !== undefined) return existing
    const started = run().finally(() => pending.delete(key))
    pending.set(key, started)
    return started
  }
}

/**
 * The in-flight key for refreshing one pull request: the route's account (which stays the same while
 * the loaded PR's account id replaces it), the PR id, its repository and region. Two accounts' PRs
 * with the same number, repository and region never share a request.
 */
export const pullRequestRefreshKey = (
  routeAccount: string | undefined,
  pullRequestId: string,
  repositoryName: string | undefined,
  region: string | undefined
): string => [routeAccount ?? "", pullRequestId, repositoryName ?? "", region ?? ""].join("\u0000")
