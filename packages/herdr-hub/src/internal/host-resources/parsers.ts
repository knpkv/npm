import { Effect, Schema } from "effect"
import type { ResourceLimit, ResourceMemoryGroup, ResourcePreview } from "../../host-resources-model.js"
import { ResourceMemory, resourcesTrendPoints } from "../../host-resources-model.js"

export class MemorySourceError
  extends Schema.TaggedError<MemorySourceError>()("MemorySourceError", { cause: Schema.Defect() })
{}
export class CpuSourceError
  extends Schema.TaggedError<CpuSourceError>()("CpuSourceError", { cause: Schema.Defect() })
{}
export class LocksSourceError
  extends Schema.TaggedError<LocksSourceError>()("LocksSourceError", { cause: Schema.Defect() })
{}
export class ProcessSourceError
  extends Schema.TaggedError<ProcessSourceError>()("ProcessSourceError", { cause: Schema.Defect() })
{}
export class PreviewSourceError
  extends Schema.TaggedError<PreviewSourceError>()("PreviewSourceError", { cause: Schema.Defect() })
{}
export class DiskSourceError
  extends Schema.TaggedError<DiskSourceError>()("DiskSourceError", { cause: Schema.Defect() })
{}

export const parseMeminfo = Effect.fn("HostResources.parseMeminfo")(function*(text: string) {
  const values = new Map(
    Array.from(
      text.matchAll(/^(MemTotal|MemAvailable|SwapTotal|SwapFree):\s+(\d+) kB$/gm),
      (m) => [m[1], Number(m[2]) * 1024]
    )
  )
  const totalBytes = values.get("MemTotal")
  const availableBytes = values.get("MemAvailable")
  const swapTotalBytes = values.get("SwapTotal")
  const swapFreeBytes = values.get("SwapFree")
  if (
    totalBytes === undefined || availableBytes === undefined || swapTotalBytes === undefined ||
    swapFreeBytes === undefined || availableBytes > totalBytes || swapFreeBytes > swapTotalBytes
  ) {
    return yield* new MemorySourceError({ cause: "missing or inconsistent meminfo fields" })
  }
  return yield* Schema.decodeUnknownEffect(ResourceMemory)({
    totalBytes,
    availableBytes,
    swapTotalBytes,
    swapUsedBytes: swapTotalBytes - swapFreeBytes
  }).pipe(Effect.mapError((cause) => new MemorySourceError({ cause })))
})

export interface CpuTicks {
  readonly total: number
  readonly idle: number
  readonly cores: number
}
export const parseCpuTicks = Effect.fn("HostResources.parseCpuTicks")(function*(text: string) {
  const fields = /^cpu\s+(.+)$/m.exec(text)?.[1]?.trim().split(/\s+/).map(Number)
  if (fields === undefined || fields.length < 4 || fields.some((n) => !Number.isFinite(n) || n < 0)) {
    return yield* new CpuSourceError({ cause: "invalid cpu ticks" })
  }
  // Guest time is already included in user/nice by the kernel.
  return {
    total: fields.slice(0, 8).reduce((a, b) => a + b, 0),
    idle: (fields[3] ?? 0) + (fields[4] ?? 0),
    cores: Array.from(text.matchAll(/^cpu\d+\s/gm)).length
  }
})
export const cpuPercent = (previous: CpuTicks | null, next: CpuTicks): number | null => {
  if (previous === null || next.total <= previous.total || next.idle < previous.idle) return null
  return Math.max(0, Math.min(100, 100 * (1 - (next.idle - previous.idle) / (next.total - previous.total))))
}
export const parseLoad = (text: string) =>
  Schema.decodeUnknownEffect(
    Schema.Tuple([
      Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0)),
      Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0)),
      Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0))
    ])
  )(text.trim().split(/\s+/).slice(0, 3).map(Number)).pipe(Effect.mapError((cause) => new CpuSourceError({ cause })))

export interface ProcLock {
  readonly pid: number
  readonly major: number
  readonly minor: number
  readonly inode: string
}
/** Waiting arrows describe contenders, never the current lock holder. */
export const parseLocks = Effect.fn("HostResources.parseLocks")(function*(text: string) {
  const locks: Array<ProcLock> = []
  for (const line of text.split("\n")) {
    if (line.trim() === "" || line.includes("->") || !line.includes("FLOCK") || /FLOCK\s+ADVISORY\s+READ/.test(line)) {
      continue
    }
    const match = /^\d+:\s+FLOCK\s+ADVISORY\s+WRITE\s+(\d+)\s+([\da-f]+):([\da-f]+):(\d+)\s+0\s+EOF$/i.exec(line)
    if (match === null) return yield* new LocksSourceError({ cause: "invalid FLOCK row" })
    locks.push({
      pid: Number(match[1]),
      major: parseInt(match[2] ?? "", 16),
      minor: parseInt(match[3] ?? "", 16),
      inode: match[4] ?? ""
    })
  }
  return locks
})

export interface ProcInfo {
  readonly pid: number
  readonly parent: number
  readonly startedAt: number
  readonly rssBytes: number
  readonly argv: ReadonlyArray<string>
  readonly pane: string | null
  readonly cwd: string
}
export const parseProcStat = Effect.fn("HostResources.parseProcStat")(
  function*(text: string, bootAt: number, ticksPerSecond: number) {
    const end = text.lastIndexOf(") ")
    const pid = Number(text.slice(0, text.indexOf(" ")))
    const fields = text.slice(end + 2).trim().split(/\s+/)
    const parent = Number(fields[1])
    const start = Number(fields[19])
    if (
      end < 0 || !Number.isSafeInteger(pid) || !Number.isSafeInteger(parent) || !Number.isFinite(start) || start < 0 ||
      ticksPerSecond <= 0
    ) return yield* new ProcessSourceError({ cause: "invalid process stat" })
    return { pid, parent, startedAt: bootAt + start / ticksPerSecond * 1000 }
  }
)
export const cmdline = (text: string): ReadonlyArray<string> => text.split("\0").filter((part) => part !== "")
export const paneFromEnvironment = (text: string): string | null =>
  text.split("\0").find((part) => part.startsWith("HERDR_PANE_ID="))?.slice("HERDR_PANE_ID=".length) || null
export const grantFromCmdline = (argv: ReadonlyArray<string>): string | null => {
  const index = argv.indexOf("--grant")
  const value = index < 0 ? undefined : argv[index + 1]
  return value !== undefined && /^[a-zA-Z0-9_.-]{1,256}$/.test(value) ? value : null
}
/** GNU timeout durations are seconds unless followed by s, m, h or d. */
export const deadlineFromCmdline = (argv: ReadonlyArray<string>): number | null => {
  if (argv[0]?.split("/").at(-1) !== "timeout") return null
  const index = 0
  const valueOptions = new Set(["-k", "--kill-after", "-s", "--signal"])
  for (let i = index + 1; i < argv.length; i++) {
    const part = argv[i] ?? ""
    if (valueOptions.has(part)) {
      i++
      continue
    }
    if (part === "--") continue
    if (["--foreground", "--preserve-status", "--verbose"].includes(part)) continue
    if (/^(?:--(?:signal|kill-after)=.+|-[sk].+)$/.test(part)) continue
    if (part.startsWith("-")) return null
    const match = /^(\d+(?:\.\d+)?)([smhd]?)$/.exec(part)
    if (match === null) return null
    const factor = match[2] === "d" ? 1440 : match[2] === "h" ? 60 : match[2] === "m" ? 1 : 1 / 60
    const minutes = Number(match[1]) * factor
    return minutes > 0 && Number.isFinite(minutes) ? minutes : null
  }
  return null
}
export const jobLimit = (deadlineMinutes: number | null): ResourceLimit =>
  deadlineMinutes !== null && deadlineMinutes < 30
    ? { kind: "deadline", minutes: deadlineMinutes }
    : { kind: "limit", minutes: 30 }
export const heldTooLong = (startedAt: number, now: number, limit: ResourceLimit): ResourceLimit | null =>
  now >= startedAt + limit.minutes * 60_000 ? limit : null
export const processTree = (pid: number, processes: ReadonlyArray<ProcInfo>): ReadonlyArray<ProcInfo> => {
  const selected = new Set([pid])
  let changed = true
  while (changed) {
    changed = false
    for (const proc of processes) {
      if (!selected.has(proc.pid) && selected.has(proc.parent)) {
        selected.add(proc.pid)
        changed = true
      }
    }
  }
  return processes.filter((proc) => selected.has(proc.pid))
}
export const groupMemory = (
  processes: ReadonlyArray<ProcInfo>,
  names: ReadonlyMap<string, string>
): ReadonlyArray<ResourceMemoryGroup> => {
  const groups = new Map<string, ResourceMemoryGroup>()
  for (const proc of processes) {
    const key = proc.pane ?? "other"
    const previous = groups.get(key)
    groups.set(key, {
      pane: proc.pane,
      lane: proc.pane === null ? null : names.get(proc.pane) ?? null,
      pid: proc.pane === null ? null : previous?.pid ?? proc.pid,
      rssBytes: (previous?.rssBytes ?? 0) + proc.rssBytes,
      processes: (previous?.processes ?? 0) + 1
    })
  }
  return [...groups.values()].sort((a, b) => b.rssBytes - a.rssBytes)
}
export const appendTrend = <A extends { readonly sampledAt: number }>(
  points: ReadonlyArray<A>,
  point: A
): ReadonlyArray<A> =>
  [...points.filter((p) => p.sampledAt > point.sampledAt - 3_600_000 && p.sampledAt < point.sampledAt), point].slice(
    -resourcesTrendPoints
  )

export interface Listener {
  readonly port: number
  readonly pid: number | null
  readonly tailnet: boolean
}
/** Same ranges, deduplication and process selection as the preview index. No HTTP probes. */
export const parseListeners = Effect.fn("HostResources.parseListeners")(function*(text: string, tailnetIp: string) {
  const listeners = new Map<number, Listener>()
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue
    const columns = line.trim().split(/\s+/)
    const address = columns[3]
    const split = address?.lastIndexOf(":") ?? -1
    if (address === undefined || split < 0) return yield* new PreviewSourceError({ cause: "invalid listener row" })
    const host = address.slice(0, split)
    const port = Number(address.slice(split + 1))
    if (!Number.isInteger(port)) return yield* new PreviewSourceError({ cause: "invalid listener port" })
    if (!((port >= 4791 && port <= 4899) || (port >= 47800 && port <= 47999) || port === 8765)) continue
    const previous = listeners.get(port)
    const pidMatch = /pid=(\d+)/.exec(columns.slice(5).join(" "))
    const preferred = host.startsWith("127.") || (tailnetIp !== "" && host.startsWith(tailnetIp))
    const tailnet = (tailnetIp !== "" && host.startsWith(tailnetIp)) || host.startsWith("[fd7a") || host === "*" ||
      host === "0.0.0.0"
    listeners.set(port, {
      port,
      pid: preferred && pidMatch !== null ? Number(pidMatch[1]) : previous?.pid ?? null,
      tailnet: tailnet || (previous?.tailnet ?? false)
    })
  }
  return [...listeners.values()].sort((a, b) => a.port - b.port)
})
export const previewRows = (
  listeners: ReadonlyArray<Listener>,
  processes: ReadonlyArray<ProcInfo>,
  labels: ReadonlyMap<string, string>
): ReadonlyArray<ResourcePreview> =>
  listeners.flatMap((listener) => {
    const proc = processes.find((p) => p.pid === listener.pid)
    const command = proc?.argv.join(" ") ?? ""
    if (/hostd\/index\.mjs|codex|syncthing|chromium/.test(command)) return []
    const cwd = proc?.cwd ?? ""
    const worktree = /worktrees\/[^/\s]+\/([^/\s]+)/.exec(`${cwd} ${command}`)?.[1]
    const directory = /--directory (\S+)/.exec(command)?.[1]
    const base = (path: string) => path.split("/").filter(Boolean).at(-1) ?? ""
    const guess = [
      worktree ?? base(cwd),
      ...(directory !== undefined && directory !== ""
        ? [`static ${base(directory)}`]
        : command.includes("server.ts")
        ? [base(command.split(" ").at(-1) ?? "")]
        : [])
    ].filter(Boolean).join(", ")
    return [{
      ...listener,
      open: { _tag: "Unavailable", reason: "not_probed" },
      label: (labels.get(String(listener.port)) || guess || `Port ${listener.port}`).slice(0, 1024)
    }]
  })

/** Bounded display copy only. Paths, assignments and shell script bodies do not cross the snapshot. */
export const displayCommand = (argv: ReadonlyArray<string>): string => {
  const executable = argv[0]?.split("/").at(-1) ?? "process"
  if (
    ["sh", "bash", "zsh", "dash"].includes(executable) &&
    argv.slice(1).some((arg) => /^-[^-]*c/.test(arg) || arg === "--command" || arg.startsWith("--command="))
  ) return `${executable} -c …`
  let redact = false
  const words = argv.slice(0, 5).map((word, index) => {
    if (redact) {
      redact = false
      return "[redacted]"
    }
    if (index > 0 && /^(?:--?(?:token|password|secret|api-key|authorization)|-c)$/.test(word)) {
      redact = true
      return word
    }
    if (index > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) return "[assignment]"
    if (/^--?(?:token|password|secret|api-key|authorization)=/.test(word)) return `${word.split("=")[0]}=[redacted]`
    return word.replace(/\p{Cc}/gu, " ").split("/").at(-1) ?? ""
  })
  const command = words.join(" ").trim() || "process"
  return command.length > 120 ? `${command.slice(0, 119)}…` : command
}
