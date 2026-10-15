import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { ConfigProvider, Effect, Exit, FileSystem, Queue, Ref, Schema, Scope, Stream } from "effect"
import { TestClock } from "effect/testing"
import {
  heavyAbortBytes,
  heavyStartBytes,
  HostResources,
  resourcesStatus,
  type ResourceUnavailable
} from "../src/host-resources-model.js"
import { makeHostResources } from "../src/host-resources.js"
import {
  appendTrend,
  cmdline,
  cpuPercent,
  deadlineFromCmdline,
  displayCommand,
  grantFromCmdline,
  groupMemory,
  heldTooLong,
  jobLimit,
  paneFromEnvironment,
  parseCpuTicks,
  parseListeners,
  parseLoad,
  parseLocks,
  parseMeminfo,
  parseProcStat,
  previewRows,
  processTree,
  type ProcInfo
} from "../src/internal/host-resources/parsers.js"
import { startResourcesSampler } from "../src/internal/host-resources/runtime.js"

const proc = (pid: number, parent: number, pane: string | null, rssBytes: number): ProcInfo => ({
  pid,
  parent,
  pane,
  rssBytes,
  startedAt: 1000,
  argv: ["node", "build.mjs"],
  cwd: "/srv/worktrees/app/maple"
})

describe("host resource sources", () => {
  it.effect("reads MemAvailable and swap in bytes and rejects missing or inconsistent fields", () =>
    Effect.gen(function*() {
      const text =
        "MemTotal:       16777216 kB\nMemAvailable:    9437184 kB\nSwapTotal:       2097152 kB\nSwapFree:        1048576 kB\n"
      expect(yield* parseMeminfo(text)).toEqual({
        totalBytes: 16 * 1024 ** 3,
        availableBytes: 9 * 1024 ** 3,
        swapTotalBytes: 2 * 1024 ** 3,
        swapUsedBytes: 1024 ** 3
      })
      expect((yield* parseMeminfo(text.replace("MemAvailable", "MemFree")).pipe(Effect.flip))._tag).toBe(
        "MemorySourceError"
      )
      expect((yield* parseMeminfo(text.replace("9437184", "99999999")).pipe(Effect.flip))._tag).toBe(
        "MemorySourceError"
      )
    }))
  it.effect("computes CPU deltas without counting guest ticks twice and handles warming up or reset", () =>
    Effect.gen(function*() {
      const first = yield* parseCpuTicks("cpu  100 20 30 400 50 0 0 0 10 2\ncpu0 1 1 1 1\ncpu1 1 1 1 1\n")
      const next = yield* parseCpuTicks("cpu  150 20 30 450 50 0 0 0 20 2\ncpu0 1 1 1 1\ncpu1 1 1 1 1\n")
      expect(first).toEqual({ total: 600, idle: 450, cores: 2 })
      expect(cpuPercent(first, next)).toBe(50)
      expect(cpuPercent(null, next)).toBeNull()
      expect(cpuPercent(next, first)).toBeNull()
      expect(yield* parseLoad("1.20 0.90 0.80 3/200 888")).toEqual([1.2, 0.9, 0.8])
      expect((yield* parseCpuTicks("cpu broken").pipe(Effect.flip))._tag).toBe("CpuSourceError")
    }))
  it.effect("selects write FLOCK holders, preserving device and inode and excluding waiters and POSIX locks", () =>
    Effect.gen(function*() {
      expect(
        yield* parseLocks(
          "1: FLOCK  ADVISORY  WRITE 41822 00:2a:98765 0 EOF\n1: -> FLOCK ADVISORY WRITE 41900 00:2a:98765 0 EOF\n2: POSIX ADVISORY WRITE 41901 00:2a:98766 0 EOF\n4: FLOCK ADVISORY READ 41901 00:2a:98766 0 EOF\n3: FLOCK ADVISORY WRITE 42011 08:01:98765 0 EOF\n"
        )
      ).toEqual([
        { pid: 41822, major: 0, minor: 42, inode: "98765" },
        { pid: 42011, major: 8, minor: 1, inode: "98765" }
      ])
      expect((yield* parseLocks("1: FLOCK invalid").pipe(Effect.flip))._tag).toBe("LocksSourceError")
    }))
  it.effect("parses proc stat around spaces and parentheses in comm, and reads only the pane environment key", () =>
    Effect.gen(function*() {
      const fields = ["S", "41", ...Array.from({ length: 17 }, () => "0"), "500", "0", "0"]
      expect(yield* parseProcStat(`42 (node (build)) ${fields.join(" ")}`, 1000, 100)).toEqual({
        pid: 42,
        parent: 41,
        startedAt: 6000
      })
      expect(paneFromEnvironment("TOKEN=private\0HERDR_PANE_ID=w2:p3\0PATH=/bin\0")).toBe("w2:p3")
      expect(paneFromEnvironment("OTHER_HERDR_PANE_ID=w2:p3\0")).toBeNull()
    }))
  it("reads explicit grants and timeout options, and carries the earlier limit's kind", () => {
    expect(grantFromCmdline(cmdline("heavy-run.sh\0--grant\0grant-demo-07\0--\0pnpm\0test\0"))).toBe("grant-demo-07")
    expect(grantFromCmdline(["node", "grant-demo-07"])).toBeNull()
    expect(grantFromCmdline(["--grant"])).toBeNull()
    expect(deadlineFromCmdline(["/usr/bin/timeout", "--signal", "TERM", "-k", "5s", "20m", "pnpm", "test"])).toBe(20)
    expect(deadlineFromCmdline(["timeout", "1.5h", "pnpm"])).toBe(90)
    expect(deadlineFromCmdline(["timeout", "120", "pnpm"])).toBe(2)
    expect(deadlineFromCmdline(["timeout", "0", "pnpm"])).toBeNull()
    expect(deadlineFromCmdline(["node", "timeout.mjs", "1m"])).toBeNull()
    expect(jobLimit(20)).toEqual({ kind: "deadline", minutes: 20 })
    expect(jobLimit(40)).toEqual({ kind: "limit", minutes: 30 })
    expect(heldTooLong(0, 20 * 60_000 - 1, jobLimit(20))).toBeNull()
    expect(heldTooLong(0, 20 * 60_000, jobLimit(20))).toEqual({ kind: "deadline", minutes: 20 })
    expect(heldTooLong(0, 30 * 60_000, jobLimit(null))).toEqual({ kind: "limit", minutes: 30 })
  })
  it("sums descendant RSS once and groups pane processes separately from unattributed processes", () => {
    const processes = [
      proc(1, 0, null, 100),
      proc(2, 1, "w2:p3", 200),
      proc(3, 2, "w2:p3", 300),
      proc(4, 3, "w2:p4", 400)
    ]
    expect(processTree(2, processes).map((p) => p.pid)).toEqual([2, 3, 4])
    expect(groupMemory(processes, new Map([["w2:p3", "ledger-cx"]]))).toEqual([
      { pane: "w2:p3", lane: "ledger-cx", pid: 2, rssBytes: 500, processes: 2 },
      { pane: "w2:p4", lane: null, pid: 4, rssBytes: 400, processes: 1 },
      { pane: null, lane: null, pid: null, rssBytes: 100, processes: 1 }
    ])
    expect(groupMemory(processes, new Map())[0]?.lane).toBeNull()
  })
  it.effect("ports match the preview index's ranges, duplicate bindings, skip list and labels", () =>
    Effect.gen(function*() {
      const row = (address: string, pid: number) => `LISTEN 0 128 ${address} 0.0.0.0:* users:(("node",pid=${pid},fd=9))`
      const listeners = yield* parseListeners(
        [
          row("127.0.0.1:4791", 2),
          row("100.64.0.1:4791", 2),
          row("0.0.0.0:4899", 3),
          row("127.0.0.1:47800", 4),
          row("127.0.0.1:47999", 5),
          row("127.0.0.1:8765", 6),
          row("127.0.0.1:4790", 7),
          row("127.0.0.1:4900", 7),
          row("127.0.0.1:5173", 7)
        ].join("\n"),
        "100.64.0.1"
      )
      expect(listeners.map((p) => p.port)).toEqual([4791, 4899, 8765, 47800, 47999])
      expect(listeners[0]).toEqual({ port: 4791, pid: 2, tailnet: true })
      const processes = [proc(2, 1, null, 0), { ...proc(4, 1, null, 0), argv: ["codex"] }, {
        ...proc(5, 1, null, 0),
        argv: ["chromium"]
      }]
      const previews = previewRows(listeners, processes, new Map([["4791", "Docs preview"]]))
      expect(previews.map((p) => p.port)).toEqual([4791, 4899, 8765])
      expect(previews[0]?.label).toBe("Docs preview")
      expect(previewRows([{ port: 4791, pid: 2, tailnet: false }], processes, new Map())[0]?.label).toBe("maple")
      expect((yield* parseListeners("malformed", "").pipe(Effect.flip))._tag).toBe("PreviewSourceError")
    }))
  it("keeps at most 360 samples and evicts gaps older than one hour without inventing points", () => {
    let points: ReadonlyArray<{ readonly sampledAt: number; readonly availableBytes: number }> = []
    for (let i = 0; i < 400; i++) points = appendTrend(points, { sampledAt: i * 10_000, availableBytes: i })
    expect(points).toHaveLength(360)
    expect(points[0]?.availableBytes).toBe(40)
    expect(appendTrend(points, { sampledAt: 8_000_000, availableBytes: 7 })).toEqual([{
      sampledAt: 8_000_000,
      availableBytes: 7
    }])
  })
  it.effect("round-trips independently unavailable sections and rejects oversized histories", () =>
    Effect.gen(function*() {
      const absent = { _tag: "Unavailable", reason: "not_configured" } satisfies ResourceUnavailable
      const snapshot: HostResources = {
        host: "maple",
        sampledAt: 1000,
        status: { _tag: "Live" },
        memory: {
          _tag: "Reading",
          value: { totalBytes: 16 * 1024 ** 3, availableBytes: 9 * 1024 ** 3, swapTotalBytes: 0, swapUsedBytes: 0 }
        },
        memoryTrend: { _tag: "Reading", value: [{ sampledAt: 1000, availableBytes: 9 * 1024 ** 3 }] },
        cpu: absent,
        disks: absent,
        tmp: absent,
        gate: absent,
        heavyJobs: absent,
        previews: absent,
        topMemory: absent
      }
      const json = yield* Schema.encodeEffect(Schema.fromJsonString(HostResources))(snapshot)
      expect(yield* Schema.decodeUnknownEffect(Schema.fromJsonString(HostResources))(json)).toEqual(snapshot)
      const invalid = {
        ...snapshot,
        memoryTrend: {
          _tag: "Reading",
          value: Array.from({ length: 361 }, () => ({ sampledAt: 0, availableBytes: 0 }))
        }
      }
      expect((yield* Schema.decodeUnknownEffect(HostResources)(invalid).pipe(Effect.flip))._tag).toBe("SchemaError")
      expect(heavyStartBytes).toBe(8 * 1024 ** 3)
      expect(heavyAbortBytes).toBe(3 * 1024 ** 3)
    }))
  it("uses the client clock for the strict 30-second stale boundary and preserves offline sample times", () => {
    expect(resourcesStatus(1000, 31_000, true)).toEqual({ _tag: "Live" })
    expect(resourcesStatus(1000, 31_001, true)).toEqual({ _tag: "Stale", lastSampleAt: 1000 })
    expect(resourcesStatus(1000, 2000, false)).toEqual({ _tag: "HostOffline", lastSampleAt: 1000 })
    expect(resourcesStatus(null, 2000, false)).toEqual({ _tag: "HostOffline", lastSampleAt: null })
  })
})

it.effect("samples immediately, repeats every ten seconds and stops with its server scope", () =>
  Effect.gen(function*() {
    const observed = yield* Queue.unbounded<number>()
    const count = yield* Ref.make(0)
    const scope = yield* Scope.make()
    const absent = { _tag: "Unavailable", reason: "not_configured" } satisfies ResourceUnavailable
    const sample = Effect.gen(function*() {
      const sequence = yield* Ref.updateAndGet(count, (n) => n + 1)
      yield* Queue.offer(observed, sequence)
      return {
        host: "maple",
        sampledAt: sequence,
        status: { _tag: "Live" },
        memory: absent,
        memoryTrend: absent,
        cpu: absent,
        disks: absent,
        tmp: absent,
        gate: absent,
        heavyJobs: absent,
        previews: absent,
        topMemory: absent
      } satisfies HostResources
    })
    const sampler = yield* startResourcesSampler(sample).pipe(Effect.provideService(Scope.Scope, scope))
    expect(yield* Queue.take(observed)).toBe(1)
    yield* TestClock.adjust(0)
    expect((yield* sampler.read)?.sampledAt).toBe(1)
    yield* TestClock.adjust("10 seconds")
    expect(yield* Queue.take(observed)).toBe(2)
    expect((yield* sampler.read)?.sampledAt).toBe(2)
    yield* Scope.close(scope, Exit.void)
    yield* TestClock.adjust("1 minute")
    expect(yield* Ref.get(count)).toBe(2)
  }))

it.live("isolates a failed memory source while CPU, disk and unconfigured gate still publish", () =>
  Effect.gen(function*() {
    const originalFs = yield* FileSystem.FileSystem
    const fs = FileSystem.makeNoop({
      readDirectory: () => Effect.succeed([]),
      stream: (path) => {
        const text = path === "/proc/meminfo"
          ? "invalid meminfo"
          : path === "/proc/loadavg"
          ? "1.0 0.5 0.2 1/50 42"
          : path === "/proc/stat"
          ? "cpu 100 0 20 500 0 0 0 0\ncpu0 100 0 20 500\nbtime 1000\n"
          : null
        return text === null ? originalFs.stream(path) : Stream.succeed(new TextEncoder().encode(text))
      }
    })
    const sampler = yield* makeHostResources({ host: "maple", herdrCommand: "false", tailscaleCommand: "false" }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs)
    )
    const snapshot = yield* sampler.read
    expect(snapshot.memory).toEqual({ _tag: "Unavailable", reason: "failed" })
    expect(snapshot.memoryTrend).toEqual({ _tag: "Unavailable", reason: "failed" })
    expect(snapshot.cpu).toEqual({ _tag: "Unavailable", reason: "warming_up" })
    expect(snapshot.tmp._tag).toBe("Reading")
    expect(snapshot.gate).toEqual({ _tag: "Unavailable", reason: "not_configured" })
    expect(snapshot.heavyJobs).toEqual({ _tag: "Unavailable", reason: "not_configured" })
    expect(snapshot.previews._tag).toBe("Reading")
    expect(snapshot.topMemory).toEqual({ _tag: "Reading", value: { namesAvailable: false, groups: [] } })
  }).pipe(
    Effect.scoped,
    Effect.provide([NodeServices.layer, ConfigProvider.layer(ConfigProvider.fromUnknown({}))])
  ))

it("keeps shell source opaque for standalone, combined and long command flags", () => {
  for (const shell of ["sh", "bash", "zsh", "dash"]) {
    for (const flag of ["-c", "-lc", "-ec", "-ilc", "--command", "--command=export BUILD_TOKEN=fixture-secret"]) {
      expect(displayCommand([`/bin/${shell}`, flag, "export BUILD_TOKEN=fixture-secret; pnpm test"])).toBe(
        `${shell} -c …`
      )
    }
  }
  expect(displayCommand(["node", "/private/project/build.mjs", "--flag", "value"])).toBe("node build.mjs --flag value")
})
