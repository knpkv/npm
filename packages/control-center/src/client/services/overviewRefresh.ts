/** One session owns one overview read and one pending refresh; disposal cancels both. */
export const makeOverviewRefresh = <A>({
  load,
  onFailure,
  onStarted,
  onSuccess
}: {
  readonly load: (signal: AbortSignal) => Promise<A>
  readonly onStarted: () => void
  readonly onSuccess: (value: A) => void
  readonly onFailure: <UnparsedCause>(cause: UnparsedCause) => void
}) => {
  let active: AbortController | null = null
  let pending = false
  let disposed = false
  const finish = (): void => {
    active = null
    if (!disposed && pending) {
      pending = false
      refresh()
    }
  }
  const refresh = (): void => {
    if (disposed) return
    if (active !== null) {
      pending = true
      return
    }
    const request = new AbortController()
    active = request
    onStarted()
    load(request.signal).then(
      (value) => {
        if (!disposed) onSuccess(value)
        finish()
      },
      (cause) => {
        if (!disposed) onFailure(cause)
        finish()
      }
    )
  }
  return {
    refresh,
    dispose: (): void => {
      disposed = true
      pending = false
      active?.abort()
    }
  }
}
