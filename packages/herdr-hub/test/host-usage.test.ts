import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import type { HostUsage, UsageNow, UsageQuery } from "@knpkv/herdr-connect"
import { Deferred, Effect, Fiber, Ref } from "effect"
import { readHostUsage, usageCache, usageCommandFor } from "../src/host-usage.js"

const query: UsageQuery = { range: "30d", timeZone: "Europe/Amsterdam" }

const answer: UsageNow = {
  v: 1,
  machine: "SER8",
  observedAt: 1_000,
  range: { preset: "30d", timeZone: "Europe/Amsterdam", from: 0, to: 1_000, bucket: "day" },
  periods: [{ key: "2026-10-08", start: 0 }],
  tokens: [{ period: 0, agent: "codex", model: "gpt-6", tokens: 4_200 }],
  limits: []
}

/**
 * A limits command standing in for agent-usage: run as usage, it prints the answer only when it was
 * given exactly the usage words, range and zone, and otherwise fails naming what it got.
 */
const limitsCommand = (output: string) => [
  "sh",
  "-c",
  `if [ "$*" = "usage --range 30d --time-zone Europe/Amsterdam" ]; then printf '%s\\n' '${output}'; else echo "got: $*" >&2; exit 2; fi`,
  "agent-usage",
  "limits"
]

const unavailable = (usage: HostUsage) => (usage.reading._tag === "Unavailable" ? usage.reading : null)

describe("usageCommandFor", () => {
  it("swaps a final `limits` for `usage`, and has none for anything else", () => {
    expect(usageCommandFor(["/nix/store/x/bin/agent-usage", "limits"])).toEqual([
      "/nix/store/x/bin/agent-usage",
      "usage"
    ])
    expect(usageCommandFor(["env", "AGENT_USAGE_HOME=/srv", "agent-usage", "limits"])).toEqual([
      "env",
      "AGENT_USAGE_HOME=/srv",
      "agent-usage",
      "usage"
    ])
    expect(usageCommandFor(undefined)).toBeUndefined()
    expect(usageCommandFor(["limits"])).toBeUndefined()
    expect(usageCommandFor(["/usr/local/bin/my-limits-wrapper"])).toBeUndefined()
  })
})

// The command runs as a real child process: these tests get Node's services from the test layer.
it.layer(NodeServices.layer)("readHostUsage", (it) => {
  it.effect("runs `usage` with the asked range and zone and serves the answer", () =>
    Effect.gen(function*() {
      const usage = yield* readHostUsage("SER8", limitsCommand(JSON.stringify(answer)), query)
      expect(usage.reading).toEqual({ _tag: "Read", usage: answer, skipped: 0 })
    }))

  it.effect("says why a host has no usage, in a fixed sentence", () =>
    Effect.gen(function*() {
      expect(unavailable(yield* readHostUsage("SER8", undefined, query))?.reason).toBe("not_configured")
      expect(unavailable(yield* readHostUsage("SER8", ["/usr/local/bin/wrapper"], query))?.detail).toContain(
        "does not end in `limits`"
      )
      const failed = unavailable(yield* readHostUsage("SER8", limitsCommand("{}"), { ...query, range: "7d" }))
      // Text agent-usage would not print is never passed on: the hub gets a fixed sentence.
      expect(failed).toEqual({
        _tag: "Unavailable",
        reason: "failed",
        detail: "agent-usage failed on this host; hostd's log has its message."
      })
      const older = unavailable(
        yield* readHostUsage("SER8", [
          "sh",
          "-c",
          "echo 'agent-usage: the running agent-usage is an older version without usage. Restart it.' >&2; exit 1",
          "agent-usage",
          "limits"
        ], query)
      )
      expect(older?.detail).toBe(
        "agent-usage on this host is an older version. Restart it (or its service) on the installed version."
      )
      expect(unavailable(yield* readHostUsage("SER8", limitsCommand("[]"), query))?.reason).toBe("invalid_output")
    }))
})

// A peer's usage crosses the tailnet to the hub: no host path may ride along in a failure.
it.layer(NodeServices.layer)("readHostUsage failures", (it) => {
  it.effect("never lets a host path out, from agent-usage's stderr or a command that cannot start", () =>
    Effect.gen(function*() {
      const socket = yield* readHostUsage("SER8", [
        "sh",
        "-c",
        "echo 'agent-usage: the control socket path /home/alice/.local/share/agent-usage/serve.sock is 140 bytes, over the 103-byte limit' >&2; exit 1",
        "agent-usage",
        "limits"
      ], query)
      const missing = yield* readHostUsage("SER8", ["/nix/store/does-not-exist/bin/agent-usage", "limits"], query)
      const garbled = yield* readHostUsage(
        "SER8",
        limitsCommand(JSON.stringify({ v: 1, machine: "/home/alice" })),
        query
      )
      expect(unavailable(socket)?.detail).toBe(
        "agent-usage's control socket on this host could not be used; hostd's log says why."
      )
      for (const usage of [socket, missing, garbled]) {
        expect(usage.reading._tag).toBe("Unavailable")
        expect(JSON.stringify(usage)).not.toMatch(/\/(?:home|nix|Users)\//u)
      }
    }))
})

describe("usageCache", () => {
  it.effect("reads each range and zone once, and drops the least recently asked beyond its size", () =>
    Effect.gen(function*() {
      const reads = yield* Ref.make<ReadonlyArray<string>>([])
      const read = (asked: UsageQuery) =>
        Ref.update(reads, (all) => [...all, `${asked.range} ${asked.timeZone}`]).pipe(
          Effect.as(
            { host: "SER8", readAt: 0, reading: { _tag: "Read", usage: answer, skipped: 0 } } satisfies HostUsage
          )
        )
      const cached = yield* usageCache(read, undefined, 2)
      const utc: UsageQuery = { range: "7d", timeZone: "UTC" }
      yield* cached(query)
      yield* cached(query)
      yield* cached(utc)
      expect(yield* Ref.get(reads)).toEqual(["30d Europe/Amsterdam", "7d UTC"])
      // A third pair drops the least recently asked (30d), so asking for it again reads again.
      yield* cached({ range: "24h", timeZone: "UTC" })
      yield* cached(utc)
      yield* cached(query)
      expect(yield* Ref.get(reads)).toEqual(["30d Europe/Amsterdam", "7d UTC", "24h UTC", "30d Europe/Amsterdam"])
    }).pipe(Effect.scoped))

  it.effect("shares one read between concurrent first asks, and runs at most two reads at once", () =>
    Effect.gen(function*() {
      const started = yield* Ref.make<ReadonlyArray<string>>([])
      const running = yield* Ref.make(0)
      const peak = yield* Ref.make(0)
      const gate = yield* Deferred.make<void>()
      const twoRunning = yield* Deferred.make<void>()
      const read = (asked: UsageQuery) =>
        Effect.gen(function*() {
          yield* Ref.update(started, (all) => [...all, `${asked.range} ${asked.timeZone}`])
          const now = yield* Ref.updateAndGet(running, (count) => count + 1)
          yield* Ref.update(peak, (most) => Math.max(most, now))
          if (now === 2) yield* Deferred.succeed(twoRunning, undefined)
          yield* Deferred.await(gate)
          yield* Ref.update(running, (count) => count - 1)
          return { host: "SER8", readAt: 0, reading: { _tag: "Read", usage: answer, skipped: 0 } } satisfies HostUsage
        })
      const cached = yield* usageCache(read)
      const asks: ReadonlyArray<UsageQuery> = [
        query,
        query,
        { range: "7d", timeZone: "UTC" },
        { range: "24h", timeZone: "UTC" }
      ]
      const fibers = yield* Effect.forEach(asks, (asked) => Effect.forkChild(cached(asked)))
      // Two reads hold the permits; the third pair waits for one, and the repeated ask shares the first read.
      yield* Deferred.await(twoRunning)
      expect(yield* Ref.get(started)).toHaveLength(2)
      yield* Deferred.succeed(gate, undefined)
      yield* Effect.forEach(fibers, Fiber.join)
      expect([...(yield* Ref.get(started))].sort()).toEqual(["24h UTC", "30d Europe/Amsterdam", "7d UTC"])
      expect(yield* Ref.get(peak)).toBe(2)
    }).pipe(Effect.scoped))
})
