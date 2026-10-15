import {
  heavyAbortBytes,
  heavyStartBytes,
  type HostResources,
  type ResourceCpu,
  resourcesIntervalMillis,
  resourcesStatus,
  type ResourceTrendPoint
} from "./host-resources-model.js"

export interface ResourcesViewState {
  readonly host: string
  readonly snapshot: HostResources | null
  readonly loading: boolean
  readonly reachable: boolean
}
export const resourceBytes = (bytes: number, fixed = false, scale = bytes): string => {
  const unit = scale >= 1024 ** 4 ? "TiB" : "GiB"
  const value = bytes / (unit === "TiB" ? 1024 ** 4 : 1024 ** 3)
  return `${fixed ? value.toFixed(1) : Number(value.toFixed(1))} ${unit}`
}
export const resourceAge = (millis: number): string =>
  millis < 60_000 ? `${Math.max(0, Math.floor(millis / 1000))}s` : `${Math.max(0, Math.floor(millis / 60_000))}m`
export const resourceTime = (millis: number): string =>
  new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" }).format(millis)
export const resourceFreshness = (
  state: ResourcesViewState,
  now: number
) => {
  const status = resourcesStatus(state.snapshot?.sampledAt ?? null, now, state.reachable)
  if (state.loading && state.snapshot === null) return { status, label: "" }
  if (status._tag === "HostOffline") return { status, label: status.lastSampleAt === null ? "no reading yet" : "" }
  return {
    status,
    label: `${status._tag === "Stale" ? "Stale, " : ""}sampled ${
      resourceAge(now - (state.snapshot?.sampledAt ?? now))
    } ago`
  }
}
export const memoryState = (
  available: number
): { readonly tone: "positive" | "caution" | "critical"; readonly label: string } =>
  available >= heavyStartBytes
    ? { tone: "positive", label: "Room for a heavy job" }
    : available >= heavyAbortBytes
    ? { tone: "caution", label: "Below heavy start" }
    : { tone: "critical", label: "Below abort" }

/** Preserve missing samples as gaps rather than connecting a line across an outage. */
export const memoryPaths = (
  points: ReadonlyArray<ResourceTrendPoint>,
  now: number,
  maximum: number
): ReadonlyArray<{ readonly line: string; readonly area: string }> => {
  const segments: Array<Array<ResourceTrendPoint>> = []
  for (const point of points.filter((p) => p.sampledAt >= now - 3_590_000 && p.sampledAt <= now)) {
    const segment = segments.at(-1)
    const previous = segment?.at(-1)
    if (segment === undefined || previous === undefined || point.sampledAt - previous.sampledAt > 15_000) {
      segments.push([point])
    } else segment.push(point)
  }
  const x = (point: ResourceTrendPoint) => ((point.sampledAt - now + 3_590_000) / 3_590_000 * 1000).toFixed(1)
  const y = (point: ResourceTrendPoint) => ((1 - Math.min(point.availableBytes, maximum) / maximum) * 200).toFixed(1)
  return segments.flatMap((segment) => {
    const first = segment[0]
    const last = segment.at(-1)
    if (first === undefined || last === undefined) return []
    const line = segment.map((point, i) => `${i > 0 ? "L" : "M"}${x(point)} ${y(point)}`).join("")
    return [{ line, area: `${line}L${x(last)} 200L${x(first)} 200Z` }]
  })
}

/** Start a new subpath after a missed CPU sample rather than drawing through unobserved time. */
export const cpuPath = (points: ResourceCpu["history"], sampledAt: number): string => {
  const visible = points.filter((point) => point.sampledAt >= sampledAt - 3_590_000 && point.sampledAt <= sampledAt)
  return visible.map((point, index) => {
    const previous = visible[index - 1]
    const move = previous === undefined || point.sampledAt - previous.sampledAt > resourcesIntervalMillis * 1.5
    const x = Math.max(0, Math.min(160, (point.sampledAt - sampledAt + 3_590_000) / 3_590_000 * 160)).toFixed(1)
    const y = (36 - point.percent / 100 * 36).toFixed(1)
    return `${move ? "M" : "L"}${x} ${y}`
  }).join("")
}
