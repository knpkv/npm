import { Data } from "effect"
import { localDay } from "../utils/time.js"
import { MINIMUM_WRITE_SECONDS } from "./writePlanning.js"

interface Run {
  readonly startMs: number
  readonly endMs: number
  readonly bucketIds: ReadonlyArray<string>
  readonly weights?: ReadonlyMap<string, number> | undefined
}

class ScheduleAllocationError extends Data.TaggedError("ScheduleAllocationError")<{ readonly message: string }> {}

export interface ScheduledRun extends Run {
  /** Earliest source instant needed to reconstruct this allocation. */
  readonly sourceStartMs: number
  /** Last source instant that can still redistribute this allocation. */
  readonly settlementEndMs: number
}

/**
 * Pack a contiguous stretch into one block per ticket, then its reserved unplaced credit.
 * First activity orders the blocks; priority determines writable shares when time is scarce.
 * Blocks may move anywhere inside their source cluster, but never invent time or bridge idle gaps.
 * Sub-minute shares fold upward in rank; an entirely shorter stretch keeps its raw short evidence.
 */
export const scheduleRuns = (
  runs: ReadonlyArray<Run>,
  dwellSeconds: number,
  attributed: (id: string) => boolean,
  priority?: (id: string, day: string) => number
): ReadonlyArray<ScheduledRun> => {
  if (dwellSeconds <= 0) {
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
    const firstActivity = new Map<string, { readonly startMs: number; readonly weight: number }>()
    for (const run of cluster) {
      const totalWeight = run.bucketIds.reduce((sum, id) => sum + (run.weights?.get(id) ?? 1), 0)
      for (const id of run.bucketIds) {
        const weight = (run.endMs - run.startMs) * (run.weights?.get(id) ?? 1) / totalWeight
        weights.set(id, (weights.get(id) ?? 0) + weight)
        active.set(id, (active.get(id) ?? 0) + run.endMs - run.startMs)
        // Mention ratios may evolve while a group is live. Ordering uses its raw first presence,
        // so later text cannot swap two same-start tickets after a restart.
        if (!firstActivity.has(id)) {
          firstActivity.set(id, { startMs: run.startMs, weight: (run.endMs - run.startMs) / run.bucketIds.length })
        }
      }
    }
    const duration = Math.floor((last.endMs - first.startMs) / 1000)
    const unplaced = [...weights].filter(([id]) => !attributed(id))
    const reserved = Math.floor(unplaced.reduce((sum, [, weight]) => sum + weight, 0) / 1000)
    const available = duration - reserved
    const day = localDay(new Date(first.startMs))
    const stableOwners = [...weights].filter(([id]) => attributed(id))
      .sort(([a, weightA], [b, weightB]) => weightB - weightA || a.localeCompare(b))
    const rankedOwners = [...stableOwners]
      .sort(([a, weightA], [b, weightB]) =>
        (priority?.(b, day) ?? 0) - (priority?.(a, day) ?? 0) || weightB - weightA || a.localeCompare(b)
      )
    const allocations = new Map<string, number>()
    let remaining = available
    let remainingWeight = stableOwners.reduce((sum, [, weight]) => sum + weight, 0)
    for (const [index, [id, weight]] of stableOwners.entries()) {
      const proportional = index === stableOwners.length - 1
        ? remaining
        : Math.floor(remaining * weight / remainingWeight)
      const seconds = Math.min(proportional, Math.floor((active.get(id) ?? 0) / 1000))
      allocations.set(id, seconds)
      remaining -= seconds
      remainingWeight -= weight
    }
    // Place credit inside its supporting runs. An augmenting path can move an existing owner's
    // credit to another supporting run, freeing room without stealing that owner's allocation.
    const placed = cluster.map(() => new Map<string, number>())
    const claimed = new Map<string, number>()
    const move = (id: string, wantedMs: number, visited: Set<number>): number => {
      let leftMs = wantedMs
      for (const [index, run] of cluster.entries()) {
        if (leftMs <= 0) break
        if (!run.bucketIds.includes(id) || visited.has(index)) continue
        const held = placed[index]
        if (held === undefined) continue
        visited.add(index)
        const freeMs = run.endMs - run.startMs - [...held.values()].reduce((sum, value) => sum + value, 0)
        const directMs = Math.min(leftMs, freeMs)
        held.set(id, (held.get(id) ?? 0) + directMs)
        leftMs -= directMs
        for (const [donor, donorMs] of [...held]) {
          if (leftMs <= 0) break
          if (donor === id || donorMs <= 0) continue
          const movedMs = move(donor, Math.min(leftMs, donorMs), visited)
          held.set(donor, (held.get(donor) ?? 0) - movedMs)
          held.set(id, (held.get(id) ?? 0) + movedMs)
          leftMs -= movedMs
        }
      }
      return wantedMs - leftMs
    }
    let budgetMs = available * 1000
    const claim = (id: string, targetSeconds: number) => {
      let wantedMs = Math.min(budgetMs, Math.max(0, targetSeconds * 1000 - (claimed.get(id) ?? 0)))
      while (wantedMs > 0) {
        const movedMs = move(id, wantedMs, new Set())
        if (movedMs <= 0) break
        claimed.set(id, (claimed.get(id) ?? 0) + movedMs)
        budgetMs -= movedMs
        wantedMs -= movedMs
      }
    }
    // Retain each owner's first second, then offer writable minutes in priority order. A floor is
    // bounded by joint source availability, not just the owner's independent active-time cap.
    for (const [id] of rankedOwners) claim(id, 1)
    for (const [id] of rankedOwners) claim(id, MINIMUM_WRITE_SECONDS)
    for (const [id] of rankedOwners) claim(id, allocations.get(id) ?? 0)
    for (const [id] of rankedOwners) claim(id, Math.floor((active.get(id) ?? 0) / 1000))
    if (budgetMs > 0) {
      throw new ScheduleAllocationError({ message: "Attribution cannot fit inside its source activity" })
    }
    if (available >= MINIMUM_WRITE_SECONDS) {
      // Folding from lowest rank upward can combine two short shares into another writable minute.
      for (let index = rankedOwners.length - 1; index > 0; index--) {
        const owner = rankedOwners[index]
        const higher = rankedOwners[index - 1]
        if (owner === undefined || higher === undefined) continue
        const milliseconds = claimed.get(owner[0]) ?? 0
        if (milliseconds <= 0 || milliseconds >= MINIMUM_WRITE_SECONDS * 1000) continue
        claimed.set(higher[0], (claimed.get(higher[0]) ?? 0) + milliseconds)
        claimed.set(owner[0], 0)
      }
      const highest = rankedOwners[0]?.[0]
      const highestMs = highest === undefined ? 0 : claimed.get(highest) ?? 0
      if (highest !== undefined && highestMs > 0 && highestMs < MINIMUM_WRITE_SECONDS * 1000) {
        const writable = rankedOwners.find(([id]) => (claimed.get(id) ?? 0) >= MINIMUM_WRITE_SECONDS * 1000)?.[0]
        if (writable !== undefined) {
          claimed.set(writable, (claimed.get(writable) ?? 0) + highestMs)
          claimed.set(highest, 0)
        }
      }
    }
    // Later work may change total weights, but never the first-activity order. Logging can change
    // advisory rank without moving an unchanged packed allocation and its consumed source identity.
    const orderedOwners = [...stableOwners].sort(([a], [b]) =>
      (firstActivity.get(a)?.startMs ?? 0) - (firstActivity.get(b)?.startMs ?? 0) ||
      (firstActivity.get(b)?.weight ?? 0) - (firstActivity.get(a)?.weight ?? 0) || a.localeCompare(b)
    )
    let cursor = first.startMs
    const append = (id: string, milliseconds: number) => {
      if (milliseconds <= 0) return
      result.push({
        bucketIds: [id],
        startMs: cursor,
        endMs: cursor + milliseconds,
        sourceStartMs: first.startMs,
        settlementEndMs
      })
      cursor += milliseconds
    }
    for (const [id] of orderedOwners) append(id, claimed.get(id) ?? 0)
    let offset = available
    for (const [index, [id, weight]] of unplaced.entries()) {
      const seconds = index === unplaced.length - 1 ? duration - offset : Math.floor(weight / 1000)
      append(id, seconds * 1000)
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
