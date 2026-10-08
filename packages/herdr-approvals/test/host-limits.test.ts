import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import type { HostLimits, LimitsNow } from "@knpkv/herdr-connect"
import { Duration, Effect, Ref } from "effect"
import { TestClock } from "effect/testing"
import { readHostLimits, staleWhileRevalidate } from "../src/host-limits.js"

// Each test effect is an application boundary; @effect/vitest scopes its Node services.
// @effect-diagnostics-next-line strictEffectProvide:off
const provideNodeServices = Effect.provide(NodeServices.layer)

/** `agent-usage limits` as it prints on a host: one window read, one that could not be. */
const answer: LimitsNow = {
  machine: "SER8",
  observedAt: 1_791_481_802_332,
  latest: [
    {
      agent: "claude",
      machine: "SER8",
      source: "claude-oauth-usage",
      label: "five_hour",
      windowMinutes: 300,
      observedAt: 1_791_481_764_274,
      reading: { _tag: "Known", usedPercent: 19, resetsAt: 1_791_485_400_000 }
    },
    {
      agent: "codex",
      machine: "SER8",
      source: "codex-rollout",
      label: "*",
      windowMinutes: null,
      observedAt: 1_791_460_492_741,
      reading: { _tag: "Unknown", reason: "NoData" }
    }
  ]
}

/** A command that prints its one argument, standing in for agent-usage. */
const printing = (output: string) => ["sh", "-c", "printf '%s\\n' \"$1\"", "agent-usage", output]

const read = (command: ReadonlyArray<string> | undefined) => readHostLimits("SER8", command).pipe(provideNodeServices)

const unavailable = (limits: HostLimits) => (limits.reading._tag === "Unavailable" ? limits.reading : null)

describe("readHostLimits", () => {
  it.effect("serves agent-usage's answer as is, an unknown window included", () =>
    Effect.gen(function*() {
      const limits = yield* read(printing(JSON.stringify(answer)))
      expect(limits.host).toBe("SER8")
      expect(limits.reading).toEqual({ _tag: "Read", limits: answer })
    }))

  it.effect("says the host has no command rather than showing empty limits", () =>
    Effect.gen(function*() {
      expect(unavailable(yield* read(undefined))?.reason).toBe("not_configured")
    }))

  it.effect("passes on agent-usage's own sentence when it fails", () =>
    Effect.gen(function*() {
      const limits = yield* read([
        "sh",
        "-c",
        "echo 'agent-usage: agent-usage is not running on this store.' >&2; exit 1"
      ])
      expect(unavailable(limits)).toEqual({
        _tag: "Unavailable",
        reason: "failed",
        detail: "agent-usage: agent-usage is not running on this store."
      })
    }))

  it.effect("rejects output that is not agent-usage's answer", () =>
    Effect.gen(function*() {
      expect(unavailable(yield* read(printing("not json")))?.reason).toBe("invalid_output")
      // An answer of another shape (here a malformed `latest`) is refused, never shown as empty.
      expect(unavailable(yield* read(printing(JSON.stringify({ ...answer, latest: "none" }))))?.reason).toBe(
        "invalid_output"
      )
    }))
})

describe("staleWhileRevalidate", () => {
  it.effect("blocks only on the first read, then serves the last value while a slow refresh runs", () =>
    Effect.gen(function*() {
      const reads = yield* Ref.make(0)
      // Every read after the first takes five seconds, longer than a peer fetch may wait.
      const slow = Ref.updateAndGet(reads, (count) => count + 1).pipe(
        Effect.tap((count) => (count > 1 ? Effect.sleep("5 seconds") : Effect.void))
      )
      const cached = yield* staleWhileRevalidate(slow, Duration.seconds(30))
      expect(yield* cached.read).toBe(1)
      expect(yield* cached.read).toBe(1)
      expect(yield* Ref.get(reads)).toBe(1)
      yield* TestClock.adjust("31 seconds")
      // Stale: answered at once from the last read, and one refresh starts.
      expect(yield* cached.read).toBe(1)
      yield* Effect.yieldNow
      expect(yield* cached.read).toBe(1)
      expect(yield* Ref.get(reads)).toBe(2)
      yield* TestClock.adjust("5 seconds")
      yield* Effect.yieldNow
      expect(yield* cached.read).toBe(2)
      expect(yield* Ref.get(reads)).toBe(2)
    }).pipe(Effect.scoped))
})
