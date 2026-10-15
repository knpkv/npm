/** Shared, read-only snapshot decoded by the host resources client. Byte values use binary units. */
import { Schema } from "effect"

export const resourcesIntervalMillis = 10_000
export const resourcesStaleMillis = 30_000
export const resourcesTrendPoints = 360
export const heavyStartBytes = 8 * 1024 ** 3
export const heavyAbortBytes = 3 * 1024 ** 3

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const Amount = Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0))
const Text = Schema.String.check(Schema.isMaxLength(1024))
export const ResourceUnavailable = Schema.TaggedStruct("Unavailable", {
  reason: Schema.Literals(["not_configured", "failed", "invalid_output", "timeout", "warming_up"])
})
export type ResourceUnavailable = typeof ResourceUnavailable.Type
const section = <S extends Schema.Top>(value: S) =>
  Schema.Union([
    Schema.TaggedStruct("Reading", { value }),
    ResourceUnavailable
  ])
export const ResourceMemory = Schema.Struct({
  totalBytes: Amount,
  availableBytes: Amount,
  swapTotalBytes: Amount,
  swapUsedBytes: Amount
})
export const ResourceTrendPoint = Schema.Struct({ sampledAt: Amount, availableBytes: Amount })
export type ResourceTrendPoint = typeof ResourceTrendPoint.Type
export const ResourceCpu = Schema.Struct({
  history: Schema.Array(Schema.Struct({ sampledAt: Amount, percent: Amount.check(Schema.isLessThanOrEqualTo(100)) }))
    .check(Schema.isMaxLength(resourcesTrendPoints)),
  cores: Count,
  percent: Amount.check(Schema.isLessThanOrEqualTo(100)),
  load: Schema.Tuple([Amount, Amount, Amount])
})
export type ResourceCpu = typeof ResourceCpu.Type
export const ResourceDisk = Schema.Struct({ mount: Text, totalBytes: Amount, usedBytes: Amount })
export const ResourceLimit = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("limit"), minutes: Schema.Literal(30) }),
  Schema.Struct({ kind: Schema.Literal("deadline"), minutes: Amount })
])
export type ResourceLimit = typeof ResourceLimit.Type
export const ResourceProcess = Schema.Struct({
  pid: Count,
  command: Schema.String.check(Schema.isMaxLength(120)),
  rssBytes: Amount
})
export const ResourceJob = Schema.Struct({
  pid: Count,
  lane: Schema.NullOr(Text),
  pane: Schema.NullOr(Text),
  command: Schema.String.check(Schema.isMaxLength(120)),
  grant: Schema.NullOr(Text),
  startedAt: Amount,
  rssBytes: Amount,
  processes: Schema.Array(ResourceProcess).check(Schema.isMaxLength(8192))
})
export type ResourceJob = typeof ResourceJob.Type
export const ResourceSlot = Schema.Struct({
  slot: Schema.Literals([1, 2]),
  holder: Schema.NullOr(ResourceJob),
  holderPids: Schema.Array(Count).check(Schema.isMaxLength(8192)),
  limit: ResourceLimit,
  heldTooLong: Schema.NullOr(ResourceLimit)
})
export const ResourcePreview = Schema.Struct({
  open: Schema.Union([
    Schema.TaggedStruct("Ready", {
      url: Schema.String.check(
        Schema.isMaxLength(2048),
        Schema.isPattern(/^https?:\/\/(?:[a-z\d](?:[a-z\d-]*[a-z\d])?\.)+[a-z][a-z\d-]*:\d+\/$/i)
      )
    }),
    Schema.TaggedStruct("Unavailable", {
      reason: Schema.Literals(["not_probed", "not_tailnet", "tailscale_unavailable", "no_dns_name", "probe_failed"])
    })
  ]),
  port: Count.check(Schema.isBetween({ minimum: 1, maximum: 65535 })),
  label: Text,
  pid: Schema.NullOr(Count),
  tailnet: Schema.Boolean
})
export type ResourcePreview = typeof ResourcePreview.Type
export const ResourceMemoryGroup = Schema.Struct({
  pane: Schema.NullOr(Text),
  lane: Schema.NullOr(Text),
  pid: Schema.NullOr(Count),
  rssBytes: Amount,
  processes: Count
})
export type ResourceMemoryGroup = typeof ResourceMemoryGroup.Type
export const ResourceStatus = Schema.Union([
  Schema.TaggedStruct("Live", {}),
  Schema.TaggedStruct("Stale", { lastSampleAt: Amount }),
  Schema.TaggedStruct("HostOffline", { lastSampleAt: Schema.NullOr(Amount) })
])
export type ResourceStatus = typeof ResourceStatus.Type
export const HostResources = Schema.Struct({
  host: Text,
  sampledAt: Amount,
  status: ResourceStatus,
  memory: section(ResourceMemory),
  memoryTrend: section(Schema.Array(ResourceTrendPoint).check(Schema.isMaxLength(resourcesTrendPoints))),
  cpu: section(ResourceCpu),
  disks: section(Schema.Array(ResourceDisk).check(Schema.isMaxLength(2))),
  tmp: section(ResourceDisk),
  gate: section(
    Schema.Struct({ slots: Schema.Array(ResourceSlot).check(Schema.isMaxLength(2)), fullGateWaiting: Schema.Boolean })
  ),
  heavyJobs: section(Schema.Array(ResourceJob).check(Schema.isMaxLength(8192))),
  previews: section(Schema.Array(ResourcePreview).check(Schema.isMaxLength(512))),
  topMemory: section(
    Schema.Struct({
      namesAvailable: Schema.Boolean,
      groups: Schema.Array(ResourceMemoryGroup).check(Schema.isMaxLength(8193))
    })
  )
})
export type HostResources = typeof HostResources.Type

/** The viewer's clock determines staleness; an unreachable host keeps the last successful sample. */
export const resourcesStatus = (sampledAt: number | null, now: number, reachable: boolean): ResourceStatus => {
  if (!reachable || sampledAt === null) return { _tag: "HostOffline", lastSampleAt: sampledAt }
  return now - sampledAt > resourcesStaleMillis ? { _tag: "Stale", lastSampleAt: sampledAt } : { _tag: "Live" }
}
