import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import type { HostUsage, UsageNow, UsageQuery } from "@knpkv/herdr-connect"
import { Effect, Ref } from "effect"
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

  it.effect("says why a host has no usage, and passes agent-usage's own sentence on", () =>
    Effect.gen(function*() {
      expect(unavailable(yield* readHostUsage("SER8", undefined, query))?.reason).toBe("not_configured")
      expect(unavailable(yield* readHostUsage("SER8", ["/usr/local/bin/wrapper"], query))?.detail).toContain(
        "does not end in `limits`"
      )
      const failed = unavailable(yield* readHostUsage("SER8", limitsCommand("{}"), { ...query, range: "7d" }))
      expect(failed).toEqual({
        _tag: "Unavailable",
        reason: "failed",
        detail: "got: usage --range 7d --time-zone Europe/Amsterdam"
      })
      expect(unavailable(yield* readHostUsage("SER8", limitsCommand("[]"), query))?.reason).toBe("invalid_output")
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
})
