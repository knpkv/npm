import { Schema } from "effect"
import {
  HostResources,
  type ResourceJob,
  type ResourceLimit,
  type ResourceMemoryGroup,
  type ResourceSlot,
  type ResourceUnavailable
} from "../../src/host-resources-model.js"
import type { ResourcesViewState } from "../../src/resources-view-model.js"
import exported from "../fixtures/host-resources.json" with { type: "json" }

const RawReading = Schema.Struct({
  memory: Schema.Struct({ available: Schema.Number, total: Schema.String, swap: Schema.String }),
  trend: Schema.Array(Schema.Number),
  cpu: Schema.Struct({
    load: Schema.Tuple([Schema.String, Schema.String, Schema.String]),
    now: Schema.String,
    spark: Schema.Array(Schema.Number)
  })
})
const RawPerson = Schema.Struct({
  agent: Schema.String,
  pane: Schema.optionalKey(Schema.String),
  rss: Schema.String,
  procs: Schema.Int
})
const RawSlot = Schema.Struct({
  job: Schema.String,
  lane: Schema.String,
  grant: Schema.String,
  age: Schema.String,
  limit: Schema.String,
  over: Schema.optionalKey(Schema.String)
})
const RawJob = Schema.Struct({
  lane: Schema.String,
  job: Schema.String,
  rss: Schema.String,
  grant: Schema.String,
  started: Schema.String,
  procs: Schema.Array(Schema.Tuple([Schema.String, Schema.String, Schema.String]))
})
const RawData = Schema.Struct({
  host: Schema.String,
  readings: Schema.Record(Schema.String, RawReading),
  states: Schema.Record(
    Schema.String,
    Schema.Struct({
      kind: Schema.optionalKey(Schema.String),
      reading: Schema.optionalKey(Schema.String),
      gate: Schema.optionalKey(Schema.String),
      jobs: Schema.optionalKey(Schema.String),
      previews: Schema.optionalKey(Schema.String),
      top: Schema.optionalKey(Schema.String),
      regions: Schema.Array(Schema.String)
    })
  ),
  gates: Schema.Record(
    Schema.String,
    Schema.Struct({
      slots: Schema.optionalKey(Schema.Array(Schema.NullOr(RawSlot))),
      waiting: Schema.optionalKey(Schema.String),
      notConfigured: Schema.optionalKey(Schema.Boolean)
    })
  ),
  jobs: Schema.Record(Schema.String, Schema.Array(RawJob)),
  previews: Schema.Record(Schema.String, Schema.Array(Schema.Struct({ label: Schema.String, port: Schema.Int }))),
  top: Schema.Record(
    Schema.String,
    Schema.Struct({ agents: Schema.Array(RawPerson), other: RawPerson, notice: Schema.optionalKey(Schema.String) })
  ),
  disk: Schema.Struct({
    mounts: Schema.Array(Schema.Struct({ path: Schema.String, used: Schema.String, size: Schema.String })),
    tmp: Schema.Struct({ used: Schema.String, quota: Schema.String })
  })
})
const data = Schema.decodeUnknownSync(RawData)(exported.data.hostResources)
export const resourceFixtureNow = new Date(2026, 9, 15, 14, 14, 4).getTime()
const ResourcesFixtureState = Schema.Literals([
  "live-healthy",
  "live-busy",
  "below-abort",
  "lock-held-too-long",
  "stale",
  "host-offline",
  "host-offline-never",
  "section-unavailable",
  "warming-up",
  "loading"
])
export const resourcesStates = ResourcesFixtureState.literals
export type ResourcesFixtureState = typeof ResourcesFixtureState.Type
const quantity = (value: string): number => {
  const parts = /^(\d+(?:\.\d+)?) (GiB|TiB)/.exec(value)
  return Number(parts?.[1]) * 1024 ** (parts?.[2] === "TiB" ? 4 : 3)
}
const time = (value: string, now: number): number => {
  const parts = /(\d\d):(\d\d)/.exec(value)
  const date = new Date(now)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), Number(parts?.[1]), Number(parts?.[2])).getTime()
}
const read = <A>(value: A) => ({ _tag: "Reading", value } satisfies { readonly _tag: "Reading"; readonly value: A })
const absent = { _tag: "Unavailable", reason: "not_configured" } satisfies ResourceUnavailable

/** Exported synthetic data drives unit tests and the real browser fixture, independently of the view. */
export const resourcesFixture = (state: ResourcesFixtureState, now = resourceFixtureNow): ResourcesViewState => {
  const selected = data.states[state]
  if (state === "loading" || state === "host-offline-never") {
    return { host: data.host, snapshot: null, loading: state === "loading", reachable: state === "loading" }
  }
  const values = data.readings[selected?.reading ?? ""]
  if (values === undefined) throw new TypeError(`missing resource reading ${state}`)
  const sampledAt = state === "host-offline" ? time("14:02", now) : now - (state === "stale" ? 120_000 : 4000)
  const jobs: ReadonlyArray<ResourceJob> = (data.jobs[selected?.jobs ?? ""] ?? []).map((job) => ({
    pid: Number(job.procs[0]?.[0]),
    lane: job.lane,
    pane: data.top.all?.agents.find((agent) => agent.agent === job.lane)?.pane ?? null,
    command: job.job,
    grant: job.grant === "no grant on cmdline" ? null : job.grant,
    startedAt: time(job.started, now),
    rssBytes: quantity(job.rss),
    processes: job.procs.map(([pid, command, rss]) => ({ pid: Number(pid), command, rssBytes: quantity(rss) }))
  }))
  const gate = data.gates[selected?.gate ?? ""]
  const slots = (gate?.slots ?? []).map((slot, index) => {
    const holder = slot === null ? null : jobs.find((job) => job.lane === slot.lane) ?? null
    const limit: ResourceLimit = slot !== null && slot.limit.startsWith("deadline")
      ? { kind: "deadline", minutes: Number(/deadline (\d+)/.exec(slot.limit)?.[1]) }
      : { kind: "limit", minutes: 30 }
    return {
      slot: index === 0 ? 1 : 2,
      holder: holder === null || slot === null
        ? null
        : { ...holder, startedAt: sampledAt - Number(/(\d+)m/.exec(slot.age)?.[1]) * 60_000 },
      holderPids: holder === null ? [] : [holder.pid],
      limit,
      heldTooLong: slot?.over === undefined ? null : limit
    } satisfies typeof ResourceSlot.Type
  })
  const top = data.top[selected?.top ?? ""]
  const groups: ReadonlyArray<ResourceMemoryGroup> = [...(top?.agents ?? []), ...(top === undefined ? [] : [top.other])]
    .map((group, index) => ({
      pane: group.pane === "—" ? null : group.pane ?? null,
      lane: group.agent.startsWith("pid ") ? null : group.agent,
      pid: group === top?.other ? null : Number(/pid (\d+)/.exec(group.agent)?.[1] ?? 100 + index),
      rssBytes: quantity(group.rss),
      processes: group.procs
    }))
  const snapshot = Schema.decodeUnknownSync(HostResources)({
    host: data.host,
    sampledAt,
    status: { _tag: "Live" },
    memory: read({
      totalBytes: quantity(values.memory.total),
      availableBytes: values.memory.available * 1024 ** 3,
      swapTotalBytes: quantity(values.memory.swap.split(" of ")[1] ?? ""),
      swapUsedBytes: quantity(values.memory.swap)
    }),
    memoryTrend: read(
      values.trend.map((available, index) => ({
        sampledAt: sampledAt - (values.trend.length - 1 - index) * 10_000,
        availableBytes: available * 1024 ** 3
      }))
    ),
    cpu: read({
      cores: 8,
      percent: Number(values.cpu.now.replace("%", "")),
      load: values.cpu.load.map(Number),
      history: values.cpu.spark.map((percent, index) => ({
        sampledAt: sampledAt - (values.cpu.spark.length - 1 - index) / (values.cpu.spark.length - 1) * 3_590_000,
        percent
      }))
    }),
    disks: read(
      data.disk.mounts.map((mount) => ({
        mount: mount.path,
        totalBytes: quantity(mount.size),
        usedBytes: quantity(mount.used)
      }))
    ),
    tmp: read({ mount: "/tmp", totalBytes: quantity(data.disk.tmp.quota), usedBytes: quantity(data.disk.tmp.used) }),
    gate: gate?.notConfigured === true ? absent : read({ slots, fullGateWaiting: gate?.waiting !== undefined }),
    heavyJobs: selected?.jobs === "notConfigured" ? absent : read(jobs),
    previews: read(
      (data.previews[selected?.previews ?? ""] ?? []).map((preview) => ({
        ...preview,
        pid: null,
        tailnet: true,
        open: { _tag: "Ready", url: `http://maple.example.test:${preview.port}/` }
      }))
    ),
    topMemory: read({ namesAvailable: top?.notice === undefined, groups })
  })
  return { host: data.host, snapshot, loading: false, reachable: state !== "host-offline" }
}
