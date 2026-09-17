import { localDay } from "../utils/time.js"

interface Run {
  readonly startMs: number
  readonly endMs: number
  readonly bucketIds: ReadonlyArray<string>
}

/**
 * Arrange a contiguous stretch into sequential allocations. Keep the strongest tickets when there
 * is not enough time for every ticket to receive the floor. Wholly unplaced time and midnight are barriers. Mixed stretches reserve their unplaced credit
 * before allocating known tickets; changing unplaced shares must not fragment every known ticket.
 * A genuinely shorter stretch stays short: allocation must never invent time or bridge idle gaps.
 */
export const scheduleRuns = (
  runs: ReadonlyArray<Run>,
  minimumSeconds: number,
  attributed: (id: string) => boolean
): ReadonlyArray<Run> => {
  if (minimumSeconds <= 0) return runs
  const result: Array<Run> = []
  let cluster: Array<Run> = []
  const flush = () => {
    const first = cluster[0]
    const last = cluster.at(-1)
    if (first === undefined || last === undefined) return
    const weights = new Map<string, number>()
    for (const run of cluster) {
      for (const id of run.bucketIds) {
        weights.set(id, (weights.get(id) ?? 0) + (run.endMs - run.startMs) / run.bucketIds.length)
      }
    }
    const duration = Math.floor((last.endMs - first.startMs) / 1000)
    const unplaced = [...weights].filter(([id]) => !attributed(id))
    const reserved = Math.floor(unplaced.reduce((sum, [, weight]) => sum + weight, 0) / 1000)
    const available = duration - reserved
    const limit = Math.max(1, Math.floor(available / minimumSeconds))
    const owners = [...weights].filter(([id]) => attributed(id))
      .sort(([a, weightA], [b, weightB]) => weightB - weightA || a.localeCompare(b)).slice(0, limit)
    for (const [index, [id]] of owners.entries()) {
      result.push({
        bucketIds: [id],
        startMs: first.startMs + Math.floor(available * index / owners.length) * 1000,
        endMs: first.startMs + Math.floor(available * (index + 1) / owners.length) * 1000
      })
    }
    let offset = available
    for (const [index, [id, weight]] of unplaced.entries()) {
      const seconds = index === unplaced.length - 1 ? duration - offset : Math.floor(weight / 1000)
      if (seconds > 0) {
        result.push({
          bucketIds: [id],
          startMs: first.startMs + offset * 1000,
          endMs: first.startMs + (offset + seconds) * 1000
        })
      }
      offset += seconds
    }
    cluster = []
  }
  for (const run of runs) {
    const previous = cluster.at(-1)
    if (
      previous !== undefined &&
      (!previous.bucketIds.some((id) => run.bucketIds.includes(id)) || previous.endMs !== run.startMs ||
        localDay(new Date(previous.startMs)) !== localDay(new Date(run.startMs)))
    ) flush()
    if (!run.bucketIds.some(attributed)) {
      flush()
      result.push(run)
    } else cluster.push(run)
  }
  flush()
  return result
}
