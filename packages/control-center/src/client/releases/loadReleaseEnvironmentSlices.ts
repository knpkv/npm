import type { EnvironmentId } from "../../domain/identifiers.js"

export const MAXIMUM_RELEASE_ENVIRONMENT_REQUEST_CONCURRENCY = 4

/** Load release scope followed by every target environment without saturating browser connection pools. */
export const loadReleaseEnvironmentSlices = async <Value>(
  environmentIds: ReadonlyArray<EnvironmentId>,
  load: (environmentId: EnvironmentId | null) => Promise<Value>
): Promise<ReadonlyArray<Value>> => {
  const scopes: ReadonlyArray<EnvironmentId | null> = [null, ...environmentIds]
  const completed: Array<{ readonly index: number; readonly value: Value }> = []
  let nextIndex = 0
  let isStopped = false
  const loadNext = async (): Promise<void> => {
    while (!isStopped && nextIndex < scopes.length) {
      const index = nextIndex
      nextIndex += 1
      const environmentId = scopes[index]
      if (environmentId === undefined) return
      try {
        completed.push({ index, value: await load(environmentId) })
      } catch (failure) {
        isStopped = true
        throw failure
      }
    }
  }
  const workerCount = Math.min(MAXIMUM_RELEASE_ENVIRONMENT_REQUEST_CONCURRENCY, scopes.length)
  await Promise.all(Array.from({ length: workerCount }, () => loadNext()))
  return completed.sort((left, right) => left.index - right.index).map(({ value }) => value)
}
