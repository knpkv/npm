/** Local Linux sampler. Its scope owns the ten-second loop and the one-hour memory history. */
import { collectBoundedText } from "@knpkv/bounded-io"
import type { HostConfiguration } from "@knpkv/herdr-fleet"
import { Clock, Config, Deferred, Effect, FileSystem, Option, Path, Ref, Result, Schema, SchemaGetter } from "effect"
import { runCommand } from "./host-limits.js"
import {
  type HostResources,
  type ResourceCpu,
  type ResourceJob,
  type ResourceLimit,
  type ResourcePreview,
  type ResourceSlot,
  type ResourceUnavailable
} from "./host-resources-model.js"
import {
  appendTrend,
  cmdline,
  cpuPercent,
  CpuSourceError,
  type CpuTicks,
  deadlineFromCmdline,
  DiskSourceError,
  displayCommand,
  grantFromCmdline,
  groupMemory,
  heldTooLong,
  jobLimit,
  LocksSourceError,
  MemorySourceError,
  paneFromEnvironment,
  parseCpuTicks,
  parseListeners,
  parseLoad,
  parseLocks,
  parseMeminfo,
  parseProcStat,
  previewRows,
  PreviewSourceError,
  ProcessSourceError,
  processTree,
  type ProcInfo
} from "./internal/host-resources/parsers.js"
import { previewKey, startPreviewProbes } from "./internal/host-resources/previews.js"
import { startResourcesSampler } from "./internal/host-resources/runtime.js"

interface ResourceReading<A> {
  readonly _tag: "Reading"
  readonly value: A
}
const reading = <A>(value: A) => ({ _tag: "Reading", value } satisfies ResourceReading<A>)
const unavailable = (reason: ResourceUnavailable["reason"]): ResourceUnavailable => ({ _tag: "Unavailable", reason })
const source = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.map(reading),
    Effect.timeoutOrElse({ duration: "5 seconds", orElse: () => Effect.succeed(unavailable("timeout")) }),
    Effect.catch((error) =>
      Effect.logDebug("Host resource source failed", error).pipe(Effect.as(unavailable("failed")))
    )
  )
const AgentList = Schema.Struct({
  result: Schema.Struct({
    agents: Schema.Array(
      Schema.Struct({ pane_id: Schema.String, name: Schema.optionalKey(Schema.NullOr(Schema.String)) })
    )
  })
})
const Labels = Schema.Record(
  Schema.String,
  Schema.Union([
    Schema.String.pipe(
      Schema.decodeTo(Schema.Struct({ label: Schema.String }), {
        decode: SchemaGetter.transform((label) => ({ label })),
        encode: SchemaGetter.transform((value) => value.label)
      })
    ),
    Schema.Struct({ label: Schema.optionalKey(Schema.String) })
  ])
)
const DiskNumbers = Schema.Tuple([
  Schema.String,
  Schema.Number.check(Schema.isFinite(), Schema.isGreaterThan(0)),
  Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0)),
  Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0))
])
const textLimit = 64 * 1024

/** Starts sampling immediately and serves the latest completed snapshot without resampling per request. */
export const makeHostResources = Effect.fn("HostResources.make")(
  function*(config: Pick<HostConfiguration, "host" | "herdrCommand" | "tailscaleCommand" | "heavyGate">) {
    const fs = yield* FileSystem.FileSystem
    const paths = yield* Path.Path
    const home = Option.getOrNull(yield* Config.option(Config.String("HOME")))
    const boundedText = (path: string, limit = textLimit) => collectBoundedText(fs.stream(path), limit)
    const command = (argv: readonly [string, ...Array<string>], limit = textLimit) =>
      runCommand(argv, limit).pipe(Effect.timeout("3 seconds"))
    const previews = yield* Ref.make<ReadonlyArray<ResourcePreview>>([])
    const firstScan = yield* Deferred.make<void>()
    const previewOpen = yield* startPreviewProbes(
      config.tailscaleCommand,
      Deferred.await(firstScan).pipe(Effect.andThen(Ref.get(previews)))
    )
    const ticks = yield* Ref.make<CpuTicks | null>(null)
    const cpuHistory = yield* Ref.make<ResourceCpu["history"]>([])
    const trend = yield* Ref.make<ReadonlyArray<{ readonly sampledAt: number; readonly availableBytes: number }>>([])

    const readMemory = boundedText("/proc/meminfo").pipe(
      Effect.mapError((cause) => new MemorySourceError({ cause })),
      Effect.flatMap(parseMeminfo)
    )
    const readCpu = Effect.gen(function*() {
      const sampledAtForCpu = yield* Clock.currentTimeMillis
      const current = yield* boundedText("/proc/stat").pipe(
        Effect.mapError((cause) => new CpuSourceError({ cause })),
        Effect.flatMap(parseCpuTicks)
      )
      const percent = cpuPercent(yield* Ref.getAndSet(ticks, current), current)
      const load = yield* boundedText("/proc/loadavg").pipe(
        Effect.mapError((cause) => new CpuSourceError({ cause })),
        Effect.flatMap(parseLoad)
      )
      const cores = yield* command(["nproc"]).pipe(
        Effect.flatMap((output) =>
          Schema.decodeUnknownEffect(Schema.Int.check(Schema.isGreaterThan(0)))(Number(output.trim()))
        ),
        Effect.mapError((cause) => new CpuSourceError({ cause }))
      )
      if (percent === null) return unavailable("warming_up")
      const history = yield* Ref.updateAndGet(
        cpuHistory,
        (points) => appendTrend(points, { sampledAt: sampledAtForCpu, percent })
      )
      return reading({ cores, percent, load, history })
    }).pipe(Effect.catchTag("CpuSourceError", () => Effect.succeed(unavailable("failed"))))
    const readDisk = Effect.fn("HostResources.readDisk")(function*(mount: string) {
      // stat -f calls statfs; free blocks keep reserved capacity out of the used count.
      const output = yield* command(["stat", "-f", "-c", "%T %S %b %f", "--", mount])
      const [fsType, blockSize, blocks, available] = yield* Schema.decodeUnknownEffect(DiskNumbers)(
        output.trim().split(/\s+/).map((part, index) => index === 0 ? part : Number(part))
      )
      if (available > blocks) return yield* new DiskSourceError({ cause: "inconsistent filesystem blocks" })
      return { mount, fsType, totalBytes: blockSize * blocks, usedBytes: blockSize * (blocks - available) }
    }, Effect.mapError((cause) => new DiskSourceError({ cause })))

    const readProcesses = Effect.gen(function*() {
      const entries = (yield* fs.readDirectory("/proc")).filter((name) => /^\d+$/.test(name))
      if (entries.length > 8192) return yield* new ProcessSourceError({ cause: "process count exceeds snapshot bound" })
      const stat = yield* boundedText("/proc/stat")
      const bootSeconds = Number(/^btime (\d+)$/m.exec(stat)?.[1])
      const ticksPerSecond = Number((yield* command(["getconf", "CLK_TCK"])).trim())
      if (!Number.isFinite(bootSeconds) || !Number.isFinite(ticksPerSecond) || ticksPerSecond <= 0) {
        return yield* new ProcessSourceError({ cause: "invalid boot time or clock ticks" })
      }
      const processes = yield* Effect.forEach(entries, (pid) =>
        Effect.gen(function*() {
          const directory = paths.join("/proc", pid)
          const stat = yield* boundedText(paths.join(directory, "stat"))
          const identity = yield* parseProcStat(stat, bootSeconds * 1000, ticksPerSecond)
          const status = yield* boundedText(paths.join(directory, "status"))
          const rss = /^VmRSS:\s+(\d+) kB$/m.exec(status)
          const argv = yield* boundedText(paths.join(directory, "cmdline")).pipe(
            Effect.map(cmdline),
            Effect.catchTag("ByteLimitExceeded", () => Effect.succeed([])),
            Effect.catchTag("PlatformError", () => Effect.succeed([]))
          )
          // Other users' environments and working directories may be private. Only the pane key leaves this read.
          const pane = yield* boundedText(paths.join(directory, "environ")).pipe(
            Effect.map(paneFromEnvironment),
            Effect.catchTag("ByteLimitExceeded", () => Effect.succeed(null)),
            Effect.catchTag("PlatformError", () => Effect.succeed(null))
          )
          const cwd = yield* fs.realPath(paths.join(directory, "cwd")).pipe(
            Effect.catchTag("PlatformError", () => Effect.succeed(""))
          )
          return { ...identity, rssBytes: rss === null ? 0 : Number(rss[1]) * 1024, argv, pane, cwd } satisfies ProcInfo
        }).pipe(
          Effect.catchTag("PlatformError", (error) =>
            error.reason._tag === "NotFound" || error.reason._tag === "PermissionDenied"
              ? Effect.succeed(null)
              : Effect.fail(error))
        ), { concurrency: 16 })
      return {
        processes: processes.filter((proc) => proc !== null),
        complete: processes.every((proc) => proc !== null)
      }
    }).pipe(Effect.timeout("5 seconds"), Effect.mapError((cause) => new ProcessSourceError({ cause })))

    const readNames = command([config.herdrCommand, "agent", "list"], 1024 * 1024).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(AgentList))),
      Effect.map((list) =>
        new Map(
          list.result.agents.flatMap((agent) =>
            agent.name !== undefined && agent.name !== null && agent.name !== ""
              ? [[agent.pane_id, agent.name] satisfies readonly [string, string]]
              : []
          )
        )
      )
    )
    const readLabels = home === null ?
      Effect.succeed(new Map<string, string>()) :
      boundedText(paths.join(home, ".cache", "host-coordinator", "previews", "labels.json")).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Labels))),
        Effect.map((labels) =>
          new Map(
            Object.entries(labels).flatMap(([port, label]) => {
              const text = label.label
              return text === undefined ? [] : [[port, text] satisfies readonly [string, string]]
            })
          )
        ),
        Effect.catchTag(
          "PlatformError",
          (error) => error.reason._tag === "NotFound" ? Effect.succeed(new Map<string, string>()) : Effect.fail(error)
        )
      )
    const readPreviews = Effect.fn("HostResources.readPreviews")(function*(processes: ReadonlyArray<ProcInfo>) {
      const { ip, labels, sockets } = yield* Effect.all({
        ip: command([config.tailscaleCommand, "ip", "-4"]).pipe(
          Effect.catchTag(["CommandFailed", "TimeoutError"], () => Effect.succeed(""))
        ),
        sockets: command(["ss", "-ltnpH"], 1024 * 1024),
        labels: readLabels
      }, { concurrency: "unbounded" })
      const rows = previewRows(yield* parseListeners(sockets, ip.trim()), processes, labels)
      yield* Ref.set(previews, rows)
      yield* Deferred.succeed(firstScan, undefined)
      const open = yield* previewOpen.read
      return rows.map((row) => ({ ...row, open: open.get(previewKey(row)) ?? row.open }))
    }, Effect.mapError((cause) => new PreviewSourceError({ cause })))

    const readGate = Effect.fn("HostResources.readGate")(
      function*(
        processes: ReadonlyArray<ProcInfo>,
        names: ReadonlyMap<string, string>,
        now: number,
        inventoryComplete: boolean
      ) {
        const directory = config.heavyGate?.lockDirectory
        if (directory === undefined) {
          return { gate: unavailable("not_configured"), heavyJobs: unavailable("not_configured") }
        }
        const globalLocks = yield* boundedText("/proc/locks", 1024 * 1024).pipe(
          Effect.flatMap(parseLocks),
          Effect.result
        )
        const locks = Result.isSuccess(globalLocks) ? globalLocks.success : []
        const currentPids = (yield* fs.readDirectory("/proc")).filter((name) => /^\d+$/.test(name))
        const knownPids = new Set(processes.map((proc) => String(proc.pid)))
        const inventoryKnown = inventoryComplete && currentPids.every((pid) => knownPids.has(pid))
        const evidence = yield* Effect.forEach([1, 2] satisfies ReadonlyArray<1 | 2>, (slot) =>
          Effect.gen(function*() {
            const file = paths.join(directory, slot === 1 ? "heavy-gate.lock" : "heavy-gate-2.lock")
            const info = yield* fs.stat(file).pipe(
              Effect.map(Option.some),
              Effect.catchTag(
                "PlatformError",
                (error) => error.reason._tag === "NotFound" ? Effect.succeed(Option.none()) : Effect.fail(error)
              )
            )
            if (Option.isNone(info)) return { slot, holders: [], unknown: false }
            if (Option.isNone(info.value.ino)) return { slot, holders: [], unknown: true }
            const resolved = yield* fs.realPath(file)
            const holders = yield* Effect.forEach(processes, (proc) =>
              Effect.gen(function*() {
                const descriptorList = yield* fs.readDirectory(paths.join("/proc", String(proc.pid), "fd")).pipe(
                  Effect.result
                )
                if (Result.isFailure(descriptorList)) {
                  return { holder: null, incomplete: true }
                }
                const descriptors = descriptorList.success
                let incomplete = false
                if (descriptors.length > 4096) {
                  return yield* new LocksSourceError({ cause: "descriptor count exceeds scan bound" })
                }
                for (const fd of descriptors) {
                  if (!/^\d+$/.test(fd)) {
                    continue
                  }
                  const path = paths.join("/proc", String(proc.pid), "fd", fd)
                  const target = yield* fs.realPath(path).pipe(Effect.result)
                  if (Result.isFailure(target)) {
                    incomplete = true
                    continue
                  }
                  if (target.success !== resolved) continue
                  const same = yield* Effect.scoped(Effect.gen(function*() {
                    const descriptor = yield* fs.open(path, { flag: "r" })
                    const descriptorInfo = yield* descriptor.stat
                    if (
                      descriptorInfo.dev !== info.value.dev || !Option.isSome(descriptorInfo.ino) ||
                      !Option.isSome(info.value.ino) || descriptorInfo.ino.value !== info.value.ino.value
                    ) return false
                    const fdinfo = yield* boundedText(paths.join("/proc", String(proc.pid), "fdinfo", fd))
                    const retained = yield* parseLocks(
                      fdinfo.split("\n").filter((line) => line.startsWith("lock:")).map((line) =>
                        line.replace(/^lock:\s*/, "")
                      ).join("\n")
                    )
                    const retainedInode = descriptorInfo.ino.value
                    // fdinfo belongs to this verified open file description, even after its acquirer exits.
                    return retained.some((record) => record.inode === String(retainedInode))
                  })).pipe(Effect.result)
                  if (Result.isFailure(same)) {
                    incomplete = true
                    continue
                  }
                  if (same.success) return { holder: proc, incomplete }
                }
                return { holder: null, incomplete }
              }), { concurrency: 16 })
            const retained = holders.flatMap((result) => result.holder === null ? [] : [result.holder])
            const unknown = retained.length === 0 && (
              !inventoryKnown || Result.isFailure(globalLocks) || holders.some((result) => result.incomplete) ||
              locks.some((lock) => lock.inode === String(Option.getOrNull(info.value.ino)))
            )
            return { slot, holders: retained, unknown }
          }))
        const rootFor = (holder: ProcInfo, retainers: ReadonlySet<number>): ProcInfo => {
          let root = holder
          let current: ProcInfo | undefined = holder
          const seen = new Set<number>()
          while (current !== undefined && !seen.has(current.pid)) {
            seen.add(current.pid)
            if (retainers.has(current.pid)) root = current
            current = processes.find((proc) => proc.pid === current?.parent)
          }
          return root
        }
        const resolvedSlots = evidence.map(({ holders, slot, unknown }) => {
          const retainers = new Set(holders.map((holder) => holder.pid))
          const roots = [...new Map(holders.map((holder) => {
            const root = rootFor(holder, retainers)
            return [root.pid, root] satisfies readonly [number, ProcInfo]
          })).values()].sort((a, b) => a.startedAt - b.startedAt || a.pid - b.pid)
          return { slot, holders, roots, unknown }
        })
        const jobRoots = new Set(resolvedSlots.flatMap((slot) => slot.roots.map((root) => root.pid)))
        const belongsTo = (proc: ProcInfo, root: ProcInfo): boolean => {
          let current: ProcInfo | undefined = proc
          const seen = new Set<number>()
          while (current !== undefined && !seen.has(current.pid)) {
            if (current.pid === root.pid) return true
            if (jobRoots.has(current.pid)) return false
            seen.add(current.pid)
            current = processes.find((proc) => proc.pid === current?.parent)
          }
          return false
        }
        const roots = [
          ...new Map(
            resolvedSlots.flatMap((slot) => slot.roots).map((root) =>
              [root.pid, root] satisfies readonly [number, ProcInfo]
            )
          ).values()
        ]
        const entries = roots.map((proc) => {
          const tree = processTree(proc.pid, processes).filter((candidate) => belongsTo(candidate, proc))
          const deadline = tree.flatMap((p) => {
            const minutes = deadlineFromCmdline(p.argv)
            return minutes === null ? [] : [{ minutes, startedAt: p.startedAt }]
          }).sort((a, b) => a.startedAt + a.minutes * 60_000 - b.startedAt - b.minutes * 60_000)[0]
          const limitAt = proc.startedAt + 30 * 60_000
          const deadlineAt = deadline === undefined ? Infinity : deadline.startedAt + deadline.minutes * 60_000
          const limit: ResourceLimit = deadline !== undefined && deadlineAt < limitAt
            ? { kind: "deadline", minutes: deadline.minutes }
            : jobLimit(null)
          const pane = proc.pane
          const child = tree.find((p) => p.pid !== proc.pid && p.argv.length > 0)
          const holder: ResourceJob = {
            pid: proc.pid,
            pane,
            lane: pane === null ? null : names.get(pane) ?? null,
            command: displayCommand(child?.argv ?? proc.argv),
            grant: grantFromCmdline(proc.argv),
            startedAt: proc.startedAt,
            rssBytes: tree.reduce((sum, p) => sum + p.rssBytes, 0),
            processes: tree.map((p) => ({
              pid: p.pid,
              command: displayCommand(p.argv),
              rssBytes: p.rssBytes
            }))
          }
          return {
            holder,
            limit,
            heldTooLong: heldTooLong(
              limit.kind === "deadline" && deadline !== undefined ? deadline.startedAt : proc.startedAt,
              now,
              limit
            )
          }
        })
        const jobs = new Map(
          entries.map((entry) => [entry.holder.pid, entry] satisfies readonly [number, typeof entry])
        )
        const slots = resolvedSlots.map(({ holders, roots, slot, unknown }) => {
          const primary = roots[0]
          const job = primary === undefined ? undefined : jobs.get(primary.pid)
          const empty = { slot, holderPids: [], holder: null, limit: jobLimit(null), heldTooLong: null }
          if (unknown) return { ...empty, status: "Unknown", reason: "ownership_unknown" } satisfies ResourceSlot
          return job === undefined
            ? { ...empty, status: "Free" } satisfies ResourceSlot
            : { slot, status: "Held", holderPids: holders.map((holder) => holder.pid), ...job } satisfies ResourceSlot
        })
        const fullGateWaiting = yield* fs.exists(paths.join(directory, "full-gate-waiting"))
        return { gate: reading({ slots, fullGateWaiting }), heavyJobs: reading(entries.map((entry) => entry.holder)) }
      },
      Effect.timeout("3 seconds"),
      Effect.mapError((cause) => new LocksSourceError({ cause })),
      Effect.catchTag(
        "LocksSourceError",
        () => Effect.succeed({ gate: unavailable("failed"), heavyJobs: unavailable("failed") })
      )
    )

    const sample = Effect.gen(function*() {
      const sampledAt = yield* Clock.currentTimeMillis
      const { cpu, disks, memory, names, processes, tmp } = yield* Effect.all({
        memory: source(readMemory),
        cpu: readCpu.pipe(
          Effect.timeoutOrElse({ duration: "5 seconds", orElse: () => Effect.succeed(unavailable("timeout")) })
        ),
        disks: source(Effect.all([readDisk("/"), readDisk("/home")], { concurrency: 2 })),
        tmp: source(readDisk("/tmp")),
        processes: readProcesses.pipe(Effect.result),
        names: readNames.pipe(Effect.result)
      }, { concurrency: "unbounded" })
      const memoryTrend = memory._tag === "Reading"
        ? reading(
          yield* Ref.updateAndGet(
            trend,
            (points) => appendTrend(points, { sampledAt, availableBytes: memory.value.availableBytes })
          )
        )
        : memory
      const nameMap = Result.isSuccess(names) ? names.success : new Map<string, string>()
      const { gateAndJobs, previews } = yield* Effect.all({
        gateAndJobs: Result.isSuccess(processes)
          ? readGate(processes.success.processes, nameMap, sampledAt, processes.success.complete)
          : Effect.succeed({
            gate: unavailable(config.heavyGate === undefined ? "not_configured" : "failed"),
            heavyJobs: unavailable(config.heavyGate === undefined ? "not_configured" : "failed")
          }),
        previews: Result.isSuccess(processes)
          ? source(readPreviews(processes.success.processes))
          : Effect.succeed(unavailable("failed"))
      }, { concurrency: "unbounded" })
      const topMemory = Result.isSuccess(processes)
        ? reading({
          namesAvailable: Result.isSuccess(names),
          groups: groupMemory(processes.success.processes, nameMap)
        })
        : unavailable("failed")
      const snapshot: HostResources = {
        host: config.host,
        sampledAt,
        status: { _tag: "Live" },
        memory,
        memoryTrend: memoryTrend._tag === "Reading" ? memoryTrend : unavailable(memoryTrend.reason),
        cpu,
        disks,
        tmp,
        ...gateAndJobs,
        previews,
        topMemory
      }
      return snapshot
    })
    return yield* startResourcesSampler(sample)
  }
)
