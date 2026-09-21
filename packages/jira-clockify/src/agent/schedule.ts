import { Data } from "effect"
import { localDay } from "../utils/time.js"

interface Run {
  readonly startMs: number
  readonly endMs: number
  readonly bucketIds: ReadonlyArray<string>
}

class ScheduleAllocationError extends Data.TaggedError("ScheduleAllocationError")<{ readonly message: string }> {}

export interface ScheduledRun extends Run {
  /** Earliest source instant needed to reconstruct this allocation. */
  readonly sourceStartMs: number
  /** Last source instant that can still redistribute this allocation. */
  readonly settlementEndMs: number
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
): ReadonlyArray<ScheduledRun> => {
  if (minimumSeconds <= 0) {
    return runs.map((run) => ({ ...run, sourceStartMs: run.startMs, settlementEndMs: run.endMs }))
  }
  const settlementEndByRun = new Map<Run, number>()
  let connectedStart = 0
  for (let index = 1; index <= runs.length; index++) {
    const previous = runs[index - 1]
    const current = runs[index]
    if (
      previous !== undefined &&
      (current === undefined || previous.endMs !== current.startMs ||
        localDay(new Date(previous.startMs)) !== localDay(new Date(current.startMs)))
    ) {
      for (let at = connectedStart; at < index; at++) {
        const run = runs[at]
        if (run !== undefined) settlementEndByRun.set(run, previous.endMs)
      }
      connectedStart = index
    }
  }
  const result: Array<ScheduledRun> = []
  let cluster: Array<Run> = []
  const flush = () => {
    const first = cluster[0]
    const last = cluster.at(-1)
    if (first === undefined || last === undefined) return
    const settlementEndMs = settlementEndByRun.get(first) ?? last.endMs
    const weights = new Map<string, number>()
    const active = new Map<string, number>()
    for (const run of cluster) {
      for (const id of run.bucketIds) {
        weights.set(id, (weights.get(id) ?? 0) + (run.endMs - run.startMs) / run.bucketIds.length)
        active.set(id, (active.get(id) ?? 0) + run.endMs - run.startMs)
      }
    }
    const duration = Math.floor((last.endMs - first.startMs) / 1000)
    const unplaced = [...weights].filter(([id]) => !attributed(id))
    const reserved = Math.floor(unplaced.reduce((sum, [, weight]) => sum + weight, 0) / 1000)
    const available = duration - reserved
    const limit = Math.max(1, Math.floor(available / minimumSeconds))
    const rankedOwners = [...weights].filter(([id]) => attributed(id))
      .sort(([a, weightA], [b, weightB]) => weightB - weightA || a.localeCompare(b))
    const owners = rankedOwners.slice(0, limit)
    const allocations = new Map<string, number>()
    let remaining = available
    let remainingWeight = owners.reduce((sum, [, weight]) => sum + weight, 0)
    for (const [index, [id, weight]] of owners.entries()) {
      const proportional = index === owners.length - 1
        ? remaining
        : Math.floor(remaining * weight / remainingWeight)
      const seconds = Math.min(proportional, Math.floor((active.get(id) ?? 0) / 1000))
      allocations.set(id, seconds)
      remaining -= seconds
      remainingWeight -= weight
    }
    // An activity cap can leave part of a proportional share unused. Offer that residual to every
    // attributable owner, including one omitted by the normal minimum-size limit, rather than
    // silently losing credited time. The residual itself may be shorter than the normal floor.
    for (const [id] of rankedOwners) {
      if (remaining <= 0) break
      const allocated = allocations.get(id) ?? 0
      const capacity = Math.floor((active.get(id) ?? 0) / 1000) - allocated
      const seconds = Math.min(remaining, Math.max(0, capacity))
      allocations.set(id, allocated + seconds)
      remaining -= seconds
    }
    const remainingMs = new Map([...allocations].map(([id, seconds]) => [id, seconds * 1000]))
    const futureActiveMs = new Map(active)
    const lastActiveMs = new Map<string, number>()
    for (const run of cluster) for (const id of run.bucketIds) lastActiveMs.set(id, run.endMs)
    const placementOrder = rankedOwners.map(([id]) => id).sort((a, b) =>
      (lastActiveMs.get(a) ?? 0) - (lastActiveMs.get(b) ?? 0)
    )
    const gaps: Array<{
      readonly startMs: number
      readonly endMs: number
      readonly bucketIds: ReadonlyArray<string>
    }> = []
    for (const run of cluster) {
      const runMs = run.endMs - run.startMs
      for (const id of run.bucketIds) futureActiveMs.set(id, (futureActiveMs.get(id) ?? 0) - runMs)
      const present = placementOrder.filter((id) => run.bucketIds.includes(id) && (remainingMs.get(id) ?? 0) > 0)
      let cursor = run.startMs
      for (const id of present) {
        const reservedForOthers = present.reduce((sum, other) =>
          other === id ?
            sum :
            sum + Math.max(0, (remainingMs.get(other) ?? 0) - (futureActiveMs.get(other) ?? 0)), 0)
        const placedMs = Math.min(remainingMs.get(id) ?? 0, Math.max(0, run.endMs - cursor - reservedForOthers))
        if (placedMs <= 0) continue
        result.push({
          bucketIds: [id],
          startMs: cursor,
          endMs: cursor + placedMs,
          sourceStartMs: first.startMs,
          settlementEndMs
        })
        remainingMs.set(id, (remainingMs.get(id) ?? 0) - placedMs)
        cursor += placedMs
      }
      if (cursor < run.endMs) {
        gaps.push({ startMs: cursor, endMs: run.endMs, bucketIds: run.bucketIds })
      }
    }
    let gapIndex = 0
    let gapCursor = gaps[0]?.startMs ?? last.endMs
    const nextGap = () => {
      gapIndex++
      gapCursor = gaps[gapIndex]?.startMs ?? last.endMs
    }
    let offset = available
    for (const [index, [id, weight]] of unplaced.entries()) {
      const seconds = index === unplaced.length - 1 ? duration - offset : Math.floor(weight / 1000)
      let milliseconds = seconds * 1000
      while (milliseconds > 0) {
        const gap = gaps[gapIndex]
        if (gap === undefined) throw new ScheduleAllocationError({ message: "Unplaced credit exceeds source activity" })
        const placedMs = Math.min(milliseconds, gap.endMs - gapCursor)
        result.push({
          bucketIds: [id],
          startMs: gapCursor,
          endMs: gapCursor + placedMs,
          sourceStartMs: first.startMs,
          settlementEndMs
        })
        milliseconds -= placedMs
        gapCursor += placedMs
        if (gapCursor === gap.endMs) nextGap()
      }
      offset += seconds
    }
    let residualMs = [...remainingMs.values()].reduce((sum, milliseconds) => sum + milliseconds, 0)
    for (let index = gapIndex; index < gaps.length && residualMs > 0; index++) {
      const gap = gaps[index]
      if (gap === undefined) continue
      if (residualMs <= 0) break
      const recipient = rankedOwners.find(([id]) => gap.bucketIds.includes(id))?.[0]
      if (recipient === undefined) continue
      const startMs = index === gapIndex ? gapCursor : gap.startMs
      const placedMs = Math.min(residualMs, gap.endMs - startMs)
      result.push({
        bucketIds: [recipient],
        startMs,
        endMs: startMs + placedMs,
        sourceStartMs: first.startMs,
        settlementEndMs
      })
      residualMs -= placedMs
    }
    if (residualMs > 0) {
      throw new ScheduleAllocationError({ message: "Attribution cannot fit inside its source activity" })
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
      result.push({
        ...run,
        sourceStartMs: run.startMs,
        settlementEndMs: settlementEndByRun.get(run) ?? run.endMs
      })
    } else cluster.push(run)
  }
  flush()
  return result.sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs)
}
