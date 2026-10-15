import { NodeServices } from "@effect/platform-node"
import { expect, it } from "@effect/vitest"
import { Clock, Config, ConfigProvider, Effect, FileSystem, Option, Path, PlatformError, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { runCommand } from "../src/host-limits.js"
import { HostResources } from "../src/host-resources-model.js"
import { makeHostResources } from "../src/host-resources.js"
import { deadlineFromCmdline } from "../src/internal/host-resources/parsers.js"

interface FixtureProcess {
  readonly pid: number
  readonly parent: number
  readonly age: number
  readonly argv: ReadonlyArray<string>
  readonly readError?: "NotFound" | "PermissionDenied"
  readonly environment?: string
}
interface GateFixture {
  readonly processes: ReadonlyArray<FixtureProcess>
  readonly acquirers?: readonly [number, number]
  readonly holders?: ReadonlyArray<number>
  readonly deviceMismatch?: boolean
  readonly collisionPid?: number
  readonly oneSlot?: boolean
  readonly slotHolders?: Readonly<Record<string, ReadonlyArray<number>>>
  readonly descriptorError?: "NotFound" | "PermissionDenied"
  readonly denyOwnership?: boolean
  readonly unlocked?: boolean
  readonly fdinfoOwner?: number
  readonly omitGlobalLocks?: boolean
  readonly unreadableGlobal?: boolean
  readonly latePids?: ReadonlyArray<number>
}
const parent: FixtureProcess = {
  pid: 42,
  parent: 1,
  age: 25,
  argv: ["bash", "/fixture/heavy-run.sh", "--grant", "grant-demo-07", "timeout", "20m", "pnpm", "test"]
}
const child: FixtureProcess = { pid: 43, parent: 42, age: 5, argv: ["/usr/bin/timeout", "20m", "pnpm", "test"] }

const gateFixture = Effect.fn("ResourcesTest.gateFixture")(function*(fixture: GateFixture) {
  const original = yield* FileSystem.FileSystem
  const root = yield* original.makeTempDirectoryScoped({ prefix: "resources-fixture-" })
  const executable = `${root}/fixture-command`
  yield* original.writeFileString(
    executable,
    `#!/bin/sh\ncase "$1" in\nagent) printf '%s' '{"result":{"agents":[{"pane_id":"w1:p1","name":"ledger-cx"}]}}';;\nip) printf '%s' '100.64.0.1';;\nstatus) printf '%s' '{"Peer":{},"Self":{"HostName":"maple","ID":"node-maple","Online":true,"TailscaleIPs":["100.64.0.1"]}}';;\nesac\n`,
    { mode: 0o700 }
  )
  const now = yield* Clock.currentTimeMillis
  const ticks = Number((yield* runCommand(["getconf", "CLK_TCK"])).trim())
  const boot = Math.floor(now / 1000) - 3600
  const descriptorFile = `${root}/descriptor`
  yield* original.writeFileString(descriptorFile, "")
  const base = yield* original.stat(root)
  const device = 0x36
  const minor = fixture.deviceMismatch === true ? 0x1d : device
  const inode = (slot: number) => slot === 1 ? 98765 : 98766
  const file = (slot: number) => `/fixture/gate/${slot === 1 ? "heavy-gate.lock" : "heavy-gate-2.lock"}`
  const acquirers = fixture.acquirers ?? [42, 42]
  const holders = fixture.holders ?? [42]
  const slots = fixture.oneSlot === true ? [1] : [1, 2]
  const owns = (pid: number, slot: number) =>
    (fixture.slotHolders?.[String(slot)] ?? holders).includes(pid) || pid === fixture.collisionPid
  const lock = (slot: number, owner = acquirers[slot - 1]) =>
    `${slot}: FLOCK ADVISORY WRITE ${owner} 00:${minor.toString(16)}:${inode(slot)} 0 EOF\n`
  const identityFor = (path: string) => {
    const descriptor = /^\/proc\/(\d+)\/fd\/(\d+)$/.exec(path)
    const slot = descriptor === null ? path.endsWith("heavy-gate-2.lock") ? 2 : 1 : Number(descriptor[2]) === 8 ? 2 : 1
    return {
      ...base,
      dev: descriptor !== null && Number(descriptor[1]) === fixture.collisionPid ? 0x47 : device,
      ino: Option.some(inode(slot))
    }
  }
  let inventoryReads = 0
  const fs = FileSystem.makeNoop({
    stat: (path) => Effect.succeed(identityFor(path)),
    open: (path, options) =>
      original.open(descriptorFile, options).pipe(
        Effect.map((opened) => ({ ...opened, stat: Effect.succeed(identityFor(path)) }))
      ),
    exists: () => Effect.succeed(false),
    readDirectory: (path) => {
      if (path === "/proc") {
        inventoryReads++
        return Effect.succeed([
          ...fixture.processes.map((p) => String(p.pid)),
          ...(inventoryReads > 1 ? (fixture.latePids ?? []).map(String) : [])
        ])
      }
      const pid = Number(/^\/proc\/(\d+)\/fd$/.exec(path)?.[1])
      return Effect.succeed(
        [
          ...(fixture.descriptorError === undefined ? [] : ["0"]),
          ...slots.filter((slot) => owns(pid, slot)).map((slot) => slot === 1 ? "9" : "8")
        ]
      )
    },
    realPath: (path) => {
      if (!path.startsWith("/proc/")) return Effect.succeed(path)
      const descriptor = /^\/proc\/(\d+)\/fd\/(\d+)$/.exec(path)
      if (descriptor !== null && (descriptor[2] === "0" || fixture.denyOwnership === true)) {
        return Effect.fail(
          new PlatformError.PlatformError(
            new PlatformError.SystemError({
              _tag: fixture.descriptorError ?? "PermissionDenied",
              module: "FileSystem",
              method: "realPath"
            })
          )
        )
      }
      return Effect.succeed(
        descriptor === null
          ? "/fixture/private-cwd"
          : Number(descriptor[1]) === fixture.collisionPid
          ? "/fixture/other/heavy-gate.lock"
          : file(Number(descriptor[2]) === 8 ? 2 : 1)
      )
    },
    stream: (path) => {
      if (path === "/proc/locks" && fixture.unreadableGlobal === true) {
        return Stream.fail(
          new PlatformError.PlatformError(
            new PlatformError.SystemError({ _tag: "PermissionDenied", module: "FileSystem", method: "stream" })
          )
        )
      }
      const match = /^\/proc\/(\d+)\/(stat|status|cmdline|environ|fdinfo\/(\d+))$/.exec(path)
      const process = fixture.processes.find((p) => p.pid === Number(match?.[1]))
      const field = match?.[2]
      if (field === "stat" && process?.readError !== undefined) {
        return Stream.fail(
          new PlatformError.PlatformError(
            new PlatformError.SystemError({ _tag: process.readError, module: "FileSystem", method: "stream" })
          )
        )
      }
      const text = path === "/proc/meminfo"
        ? "MemTotal: 16000000 kB\nMemAvailable: 9000000 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n"
        : path === "/proc/loadavg"
        ? "1.0 0.5 0.2 1/50 42"
        : path === "/proc/stat"
        ? `cpu 100 0 20 500 0 0 0 0\ncpu0 100 0 20 500\nbtime ${boot}\n`
        : path === "/proc/locks"
        ? fixture.unlocked === true || fixture.omitGlobalLocks === true ? "" : slots.map((slot) => lock(slot)).join("")
        : field === "stat" && process !== undefined
        ? `${process.pid} (node fixture) ${
          [
            "S",
            String(process.parent),
            ...Array.from({ length: 17 }, () => "0"),
            String(Math.floor((3600 - process.age * 60) * ticks)),
            "0",
            "0"
          ].join(" ")
        }`
        : field === "status"
        ? "VmRSS: 100 kB\n"
        : field === "cmdline"
        ? `${process?.argv.join("\0")}\0`
        : field === "environ"
        ? process?.environment ?? "HERDR_PANE_ID=w1:p1\0"
        : field?.startsWith("fdinfo/") === true
        ? `pos:\t0\nflags:\t0100002\nino:\t${inode(Number(match?.[3]) === 8 ? 2 : 1)}\nlock:\t${
          lock(Number(match?.[3]) === 8 ? 2 : 1, fixture.fdinfoOwner)
        }`
        : ""
      return Stream.succeed(new TextEncoder().encode(text))
    }
  })
  const sampler = yield* makeHostResources({
    host: "maple",
    herdrCommand: executable,
    tailscaleCommand: executable,
    heavyGate: { lockDirectory: "/fixture/gate" }
  }).pipe(Effect.provideService(FileSystem.FileSystem, fs))
  return yield* sampler.read
})
const runFixture = (fixture: GateFixture) =>
  gateFixture(fixture).pipe(
    Effect.scoped,
    Effect.provide([NodeServices.layer, ConfigProvider.layer(ConfigProvider.fromUnknown({}))])
  )
const held = (snapshot: HostResources) =>
  snapshot.gate._tag === "Reading" ? snapshot.gate.value.slots.filter((s) => s.holder !== null) : []

it.live("resolves an exited flock acquirer to every retaining process and its topmost job root", () =>
  Effect.gen(function*() {
    const snapshot = yield* runFixture({ processes: [parent, child], acquirers: [44, 45], holders: [42, 43] })
    expect(snapshot.gate._tag).toBe("Reading")
    expect(held(snapshot).map((s) => s.holder?.pid)).toEqual([42, 42])
    expect(held(snapshot)[0]?.holder?.lane).toBe("ledger-cx")
    expect(held(snapshot)[0]?.holder?.processes.map((p) => p.pid)).toEqual([42, 43])
    expect(held(snapshot)[0]?.holder?.rssBytes).toBe(200 * 1024)
  }))
for (const lockEvidence of ["pid-zero", "no-global-record", "unreadable-global"]) {
  it.live(`trusts verified descriptor lock evidence with ${lockEvidence}`, () =>
    Effect.gen(function*() {
      const snapshot = yield* runFixture({
        processes: [parent, child],
        holders: [42, 43],
        fdinfoOwner: lockEvidence === "pid-zero" ? 0 : 44,
        omitGlobalLocks: lockEvidence === "no-global-record",
        unreadableGlobal: lockEvidence === "unreadable-global"
      })
      expect(held(snapshot).map((slot) => slot.holder?.pid)).toEqual([42, 42])
      expect(held(snapshot)[0]?.holderPids).toEqual([42, 43])
    }))
}

it.live("does not charge a future timeout argument to the parent's earlier start", () =>
  Effect.gen(function*() {
    const snapshot = yield* runFixture({ processes: [parent, child], holders: [42, 43] })
    expect(held(snapshot)[0]?.limit).toEqual({ kind: "limit", minutes: 30 })
    expect(held(snapshot)[0]?.heldTooLong).toBeNull()
    expect(deadlineFromCmdline(["node", "logger.mjs", "timeout", "1m"])).toBeNull()
    expect(deadlineFromCmdline(["/usr/bin/timeout", "--signal", "TERM", "-k", "5s", "20m", "pnpm", "test"])).toBe(20)
  }))
for (const field of ["environment", "argv"] satisfies ReadonlyArray<"environment" | "argv">) {
  it.live(`isolates oversized ${field} while unrelated gate, previews and RSS remain readable`, () =>
    Effect.gen(function*() {
      const unrelated: FixtureProcess = {
        pid: 99,
        parent: 1,
        age: 1,
        argv: ["node", ...(field === "argv" ? ["x".repeat(65537)] : ["other.mjs"])],
        environment: field === "environment"
          ? `HERDR_PANE_ID=w9:p9\0LONG=${"x".repeat(65537)}`
          : "HERDR_PANE_ID=w9:p9\0"
      }
      const snapshot = yield* runFixture({ processes: [parent, child, unrelated], holders: [42, 43] })
      expect(snapshot.topMemory._tag).toBe("Reading")
      expect(snapshot.gate._tag).toBe("Reading")
      expect(snapshot.heavyJobs._tag).toBe("Reading")
      expect(snapshot.previews._tag).toBe("Reading")
      if (snapshot.topMemory._tag === "Reading") {
        expect(snapshot.topMemory.value.groups.reduce((sum, group) => sum + group.rssBytes, 0)).toBe(300 * 1024)
      }
    }))
}
it.live("counts one full-gate job once while preserving both held slots", () =>
  Effect.gen(function*() {
    const snapshot = yield* runFixture({ processes: [parent, child], holders: [42, 43] })
    expect(held(snapshot)).toHaveLength(2)
    expect(snapshot.heavyJobs._tag === "Reading" ? snapshot.heavyJobs.value.map((j) => j.pid) : []).toEqual([42])
  }))
it.live("joins Btrfs fdinfo lock identity with the exact descriptor target and excludes a colliding inode on another device", () =>
  Effect.gen(function*() {
    const collision = { ...parent, pid: 52, parent: 1 }
    const snapshot = yield* runFixture({
      processes: [parent, child, collision],
      acquirers: [44, 45],
      holders: [42, 43],
      deviceMismatch: true,
      collisionPid: 52
    })
    expect(held(snapshot).map((slot) => slot.holder?.pid)).toEqual([42, 42])
    expect(held(snapshot)[0]?.holder?.processes.map((p) => p.pid)).toEqual([42, 43])
  }))
it.live("elides the entire unknown argument form rather than truncating private values", () =>
  Effect.gen(function*() {
    const job = { ...parent, argv: ["/private/bin/node", "/private/project/build.mjs", "--flag", "x".repeat(200)] }
    const snapshot = yield* runFixture({ processes: [job], holders: [42] })
    const commands = snapshot.heavyJobs._tag === "Reading"
      ? snapshot.heavyJobs.value.flatMap((j) => [j.command, ...j.processes.map((p) => p.command)])
      : []
    expect(commands.length).toBeGreaterThan(0)
    expect(
      commands.every((command) => command === "node …")
    ).toBe(true)
  }))

it.live("preserves direct holders, genuinely separate jobs and unlocked files", () =>
  Effect.gen(function*() {
    const separate = { ...parent, pid: 52, parent: 1 }
    const snapshot = yield* runFixture({
      processes: [parent, separate],
      acquirers: [42, 52],
      slotHolders: { "1": [42], "2": [52] }
    })
    expect(held(snapshot).map((slot) => slot.holder?.pid)).toEqual([42, 52])
    expect(snapshot.heavyJobs._tag === "Reading" ? snapshot.heavyJobs.value.map((job) => job.pid) : []).toEqual([
      42,
      52
    ])
    const free = yield* runFixture({ processes: [parent], holders: [], unlocked: true })
    expect(free.gate._tag).toBe("Reading")
    expect(held(free)).toHaveLength(0)
  }))

const realRetainedLock = Effect.fn("ResourcesTest.retainedLock")(function*(directory?: string) {
  const fs = yield* FileSystem.FileSystem
  const root = yield* fs.makeTempDirectoryScoped(
    directory === undefined ? { prefix: "resources-lock-" } : { directory, prefix: "resources-lock-" }
  )
  const lock = `${root}/heavy-gate.lock`
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const script =
    "exec 9>\"$1\"; flock -n 9 & acquirer=$!; wait \"$acquirer\"; mkfifo \"$1.release\"; cat \"$1.release\" >/dev/null & child=$!; printf \"%s %s %s\\n\" \"$$\" \"$child\" \"$acquirer\"; read -r release; printf done >\"$1.release\"; wait \"$child\""
  const handle = yield* spawner.spawn(ChildProcess.make("sh", ["-c", script, "lock-fixture", lock]))
  yield* Effect.addFinalizer(() =>
    Stream.make(new TextEncoder().encode("done\n")).pipe(
      Stream.run(handle.stdin),
      Effect.andThen(handle.exitCode),
      Effect.orDie,
      Effect.asVoid
    )
  )
  const line = yield* handle.stdout.pipe(Stream.decodeText, Stream.splitLines, Stream.runHead)
  const ids = yield* Schema.decodeUnknownEffect(Schema.Tuple([Schema.Int, Schema.Int, Schema.Int]))(
    Option.getOrElse(line, () => "").split(" ").map(Number)
  )
  const [parent, child, acquirer] = ids
  expect(yield* fs.exists(`/proc/${acquirer}`)).toBe(false)
  const testFs = {
    ...fs,
    readDirectory: (path: string) =>
      path === "/proc" ? Effect.succeed([String(parent), String(child)]) : fs.readDirectory(path)
  }
  const sampler = yield* makeHostResources({
    host: "maple",
    herdrCommand: "false",
    tailscaleCommand: "false",
    heavyGate: { lockDirectory: root }
  }).pipe(Effect.provideService(FileSystem.FileSystem, testFs))
  const snapshot = yield* sampler.read
  expect(held(snapshot)[0]?.holder?.pid).toBe(parent)
  expect([...(held(snapshot)[0]?.holderPids ?? [])].sort()).toEqual([parent, child].sort())
  expect(held(snapshot)[0]?.holder?.processes.map((p) => p.pid)).toContain(child)
})
it.layer(NodeServices.layer, { excludeTestServices: true })("real retained locks", (it) => {
  it.effect("observes a real inherited descriptor after its flock child has naturally exited", () =>
    realRetainedLock().pipe(Effect.scoped))
  it.effect("observes a real Btrfs-backed inherited descriptor when Btrfs is available", () =>
    Effect.gen(function*() {
      const paths = yield* Path.Path
      const home = yield* Config.String("HOME")
      const directory = paths.join(home, ".cache")
      const type = yield* runCommand(["stat", "-f", "-c", "%T", directory])
      if (type.trim() === "btrfs") yield* realRetainedLock(directory)
    }).pipe(Effect.scoped))
})

for (
  const descriptorError of ["NotFound", "PermissionDenied"] satisfies ReadonlyArray<
    NonNullable<GateFixture["descriptorError"]>
  >
) {
  it.live(`continues past an unrelated ${descriptorError} descriptor and preserves every retainer`, () =>
    Effect.gen(function*() {
      const snapshot = yield* runFixture({ processes: [parent, child], holders: [42, 43], descriptorError })
      expect(held(snapshot).map((slot) => slot.holder?.pid)).toEqual([42, 42])
      expect(held(snapshot)[0]?.holderPids).toEqual([42, 43])
    }))
}
it.live("does not prove a slot free when all ownership evidence is denied", () =>
  Effect.gen(function*() {
    const snapshot = yield* runFixture({ processes: [parent], holders: [42], denyOwnership: true })
    expect(snapshot.gate._tag === "Reading" ? snapshot.gate.value.slots.map((slot) => slot.status) : []).toEqual([
      "Unknown",
      "Unknown"
    ])
  }))
it.live("keeps ancestor and descendant jobs separate when they retain different slots", () =>
  Effect.gen(function*() {
    const snapshot = yield* runFixture({
      processes: [parent, child],
      acquirers: [42, 43],
      slotHolders: { "1": [42], "2": [43] }
    })
    expect(held(snapshot).map((slot) => slot.holder?.pid)).toEqual([42, 43])
    expect(snapshot.heavyJobs._tag === "Reading" ? snapshot.heavyJobs.value.map((job) => job.pid) : []).toEqual([
      42,
      43
    ])
  }))
it.live("treats combined and long shell command operands as opaque in both command projections", () =>
  Effect.gen(function*() {
    for (
      const argv of [
        ["bash", "-lc", "export BUILD_TOKEN=fixture-secret; pnpm test"],
        ["sh", "-ec", "BUILD_TOKEN=fixture-secret pnpm test"],
        ["zsh", "--command", "BUILD_TOKEN=fixture-secret pnpm test"],
        ["dash", "--command=BUILD_TOKEN=fixture-secret pnpm test"]
      ]
    ) {
      const snapshot = yield* runFixture({ processes: [{ ...parent, argv }], holders: [42] })
      const commands = snapshot.heavyJobs._tag === "Reading"
        ? snapshot.heavyJobs.value.flatMap((job) => [job.command, ...job.processes.map((p) => p.command)])
        : []
      expect(commands.length).toBeGreaterThan(0)
      expect(commands.every((command) => command === `${argv[0]} -c …`)).toBe(true)
    }
  }))

for (const secondRoot of [42, 52]) {
  it.live(`conserves process membership when slot 1 is shared and slot 2 belongs to ${secondRoot}`, () =>
    Effect.gen(function*() {
      const otherRoot = { ...parent, pid: 52, parent: 1 }
      const otherChild = { ...child, pid: 53, parent: 52 }
      const snapshot = yield* runFixture({
        processes: [parent, child, otherRoot, otherChild],
        acquirers: [44, 45],
        slotHolders: { "1": [42, 52], "2": [secondRoot] }
      })
      expect(snapshot.heavyJobs._tag).toBe("Reading")
      if (snapshot.heavyJobs._tag === "Reading") {
        const pids = snapshot.heavyJobs.value.flatMap((job) => job.processes.map((p) => p.pid)).sort((a, b) => a - b)
        expect(pids).toEqual([42, 43, 52, 53])
        expect(snapshot.heavyJobs.value.reduce((sum, job) => sum + job.rssBytes, 0)).toBe(400 * 1024)
      }
    }))
}

it.live("keeps wrapped shell and unknown argument secrets out of every wire command", () =>
  Effect.gen(function*() {
    for (
      const argv of [
        ["timeout", "20m", "bash", "-lc", "export BUILD_TOKEN=fixture-secret; sleep 600"],
        ["curl", "-H", "Authorization: Bearer fixture-secret"],
        ["tool", "--client-secret", "fixture-secret"]
      ]
    ) {
      const snapshot = yield* runFixture({ processes: [{ ...parent, argv }], holders: [42] })
      const commands = snapshot.heavyJobs._tag === "Reading"
        ? snapshot.heavyJobs.value.flatMap((job) => [job.command, ...job.processes.map((proc) => proc.command)]) :
        []
      expect(commands.length).toBeGreaterThan(0)
      expect(commands.join(" ")).not.toContain("fixture-secret")
      expect(JSON.stringify(snapshot)).not.toContain("BUILD_TOKEN")
    }
  }))
it.live("isolates malformed pane environments and keeps the complete snapshot decodable", () =>
  Effect.gen(function*() {
    const snapshot = yield* runFixture({
      processes: [{ ...parent, environment: `HERDR_PANE_ID=${"x".repeat(1025)}\0` }]
    })
    expect(snapshot.topMemory._tag === "Reading" ? snapshot.topMemory.value.groups[0]?.pane : "unavailable").toBeNull()
    expect(Schema.decodeUnknownSync(HostResources)(snapshot)).toEqual(snapshot)
  }))

it.layer(NodeServices.layer, { excludeTestServices: true })("filesystem capacity", (it) => {
  it.effect("reports the actual filesystem type with the sampled capacity", () =>
    Effect.gen(function*() {
      const expected = (yield* runCommand(["stat", "-f", "-c", "%T", "/tmp"])).trim()
      const snapshot = yield* runFixture({ processes: [] })
      expect(snapshot.tmp._tag === "Reading" ? snapshot.tmp.value.fsType : "unavailable").toBe(expected)
    }))
})

it.live("reports unresolved positive lock evidence as unknown, retaining only proven jobs", () =>
  Effect.gen(function*() {
    const snapshot = yield* runFixture({
      processes: [child],
      acquirers: [44, 45],
      slotHolders: { "1": [42], "2": [43] }
    })
    expect(snapshot.gate._tag).toBe("Reading")
    if (snapshot.gate._tag === "Reading") {
      expect(snapshot.gate.value.slots[0]).toMatchObject({
        status: "Unknown",
        reason: "ownership_unknown",
        holder: null
      })
      expect(snapshot.gate.value.slots[1]).toMatchObject({ status: "Held", holder: { pid: 43 } })
    }
    expect(snapshot.heavyJobs._tag === "Reading" ? snapshot.heavyJobs.value.map((job) => job.pid) : []).toEqual([43])
  }))
for (
  const readError of ["NotFound", "PermissionDenied"] satisfies ReadonlyArray<NonNullable<FixtureProcess["readError"]>>
) {
  it.live(`never infers free from an inventory missing a ${readError} process`, () =>
    Effect.gen(function*() {
      const snapshot = yield* runFixture({
        processes: [{ ...parent, readError }, child],
        omitGlobalLocks: true,
        slotHolders: { "1": [42], "2": [43] }
      })
      expect(snapshot.gate._tag === "Reading" ? snapshot.gate.value.slots[0]?.status : "unavailable").toBe("Unknown")
      const free = yield* runFixture({ processes: [], holders: [], unlocked: true })
      expect(free.gate._tag === "Reading" ? free.gate.value.slots.map((slot) => slot.status) : []).toEqual([
        "Free",
        "Free"
      ])
    }))
}

it.live("does not prove free when a new process appears after the metadata inventory", () =>
  Effect.gen(function*() {
    const snapshot = yield* runFixture({
      processes: [child],
      latePids: [52],
      omitGlobalLocks: true,
      slotHolders: { "1": [52], "2": [43] }
    })
    expect(snapshot.gate._tag === "Reading" ? snapshot.gate.value.slots.map((slot) => slot.status) : []).toEqual([
      "Unknown",
      "Held"
    ])
  }))
