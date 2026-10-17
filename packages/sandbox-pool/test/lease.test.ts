import { describe, expect, it } from "@effect/vitest"
import { DateTime, Duration, Effect, Schema } from "effect"
import {
  expire,
  extend,
  Holder,
  lease,
  manualReset,
  release,
  resetFailed,
  resetSucceeded,
  retry,
  RunId,
  Sandbox,
  SandboxState,
  timeLeft
} from "../src/index.js"

const at = (iso: string) => DateTime.makeUnsafe(iso)
const t0 = at("2026-10-16T08:00:00Z")
const agent = Schema.decodeUnknownSync(Holder)("agent-a")
const other = Schema.decodeUnknownSync(Holder)("agent-b")
const run1 = Schema.decodeUnknownSync(RunId)("run-1")
const run2 = Schema.decodeUnknownSync(RunId)("run-2")

const decode = Schema.decodeUnknownSync(Sandbox)
const available = (name: "sandbox-a" | "sandbox-b", lastResetAt: string | null) =>
  decode({
    accountId: name === "sandbox-a" ? "111111111111" : "222222222222",
    name,
    state: { _tag: "Available", lastResetAt },
    version: 0
  })

const failureTag = <A, E extends { readonly _tag: string }>(effect: Effect.Effect<A, E>) =>
  Effect.flip(effect).pipe(Effect.map((error) => error._tag))

describe("sandbox lease", () => {
  it.effect("lease takes the longest-idle account for 8h and bumps the version", () =>
    Effect.gen(function*() {
      const pool = [
        available("sandbox-a", "2026-10-15T10:00:00Z"),
        available("sandbox-b", "2026-10-14T10:00:00Z")
      ]
      const leased = yield* lease(pool, agent, t0)
      expect(leased.name).toBe("sandbox-b")
      expect(leased.version).toBe(1)
      expect(leased.state).toEqual(
        SandboxState.cases.Leased.make({ holder: agent, startedAt: t0, endsAt: at("2026-10-16T16:00:00Z") })
      )
      expect(timeLeft(leased, at("2026-10-16T15:00:00Z"))).toEqual(Duration.hours(1))
    }))

  it.effect("lease with nothing available fails NoneAvailable", () =>
    Effect.gen(function*() {
      const pool = [yield* lease([available("sandbox-a", null)], agent, t0)]
      expect(yield* failureTag(lease(pool, other, t0))).toBe("NoneAvailable")
    }))

  it.effect("extend adds 8h, only for the holder, and stops at the 24h cap", () =>
    Effect.gen(function*() {
      const leased = yield* lease([available("sandbox-a", null)], agent, t0)
      expect(yield* failureTag(extend(leased, other))).toBe("NotHolder")
      const once = yield* extend(leased, agent)
      expect(once.state).toMatchObject({ _tag: "Leased", endsAt: at("2026-10-17T00:00:00Z") })
      const twice = yield* extend(once, agent)
      expect(twice.state).toMatchObject({ _tag: "Leased", endsAt: at("2026-10-17T08:00:00Z") })
      expect(yield* failureTag(extend(twice, agent))).toBe("CapReached")
    }))

  it.effect("release by the holder starts a reset run; others cannot release", () =>
    Effect.gen(function*() {
      const leased = yield* lease([available("sandbox-a", null)], agent, t0)
      expect(yield* failureTag(release(leased, other, run1, t0))).toBe("NotHolder")
      const cleaning = yield* release(leased, agent, run1, t0)
      expect(cleaning.state).toEqual(SandboxState.cases.Cleaning.make({ since: t0, runId: run1, reason: "Released" }))
    }))

  it.effect("the sweeper expires only leases past their end", () =>
    Effect.gen(function*() {
      const leased = yield* lease([available("sandbox-a", null)], agent, t0)
      expect(expire(leased, run1, at("2026-10-16T15:59:59Z"))).toBe(leased)
      const expired = expire(leased, run1, at("2026-10-16T16:00:00Z"))
      expect(expired.state).toMatchObject({ _tag: "Cleaning", reason: "Expired" })
      const idle = available("sandbox-b", null)
      expect(expire(idle, run1, t0)).toBe(idle)
    }))

  it.effect("reset results apply only to the current run", () =>
    Effect.gen(function*() {
      const cleaning = yield* release(yield* lease([available("sandbox-a", null)], agent, t0), agent, run1, t0)
      expect(yield* failureTag(resetSucceeded(cleaning, run2, t0))).toBe("StaleRun")
      const done = yield* resetSucceeded(cleaning, run1, at("2026-10-16T08:20:00Z"))
      expect(done.state).toEqual(SandboxState.cases.Available.make({ lastResetAt: at("2026-10-16T08:20:00Z") }))
      const quarantined = yield* resetFailed(cleaning, run1, "S3 bucket ephemeral-x: AccessDenied", t0)
      expect(quarantined.state._tag).toBe("Quarantined")
      expect(yield* failureTag(resetSucceeded(quarantined, run1, t0))).toBe("InvalidTransition")
    }))

  it.effect("quarantine retries with a fresh run; illegal transitions are refused", () =>
    Effect.gen(function*() {
      const idle = available("sandbox-a", null)
      expect(yield* failureTag(retry(idle, run1, t0))).toBe("InvalidTransition")
      expect(yield* failureTag(extend(idle, agent))).toBe("InvalidTransition")
      expect(yield* failureTag(release(idle, agent, run1, t0))).toBe("InvalidTransition")
      const cleaning = yield* manualReset(idle, run1, t0)
      expect(yield* failureTag(manualReset(cleaning, run2, t0))).toBe("InvalidTransition")
      const quarantined = yield* resetFailed(cleaning, run1, "blocker", t0)
      const retried = yield* retry(quarantined, run2, t0)
      expect(retried.state).toMatchObject({ _tag: "Cleaning", runId: run2 })
    }))

  it.effect("stored sandboxes round-trip through the boundary schema", () =>
    Effect.gen(function*() {
      const leased = yield* lease([available("sandbox-a", null)], agent, t0)
      const encoded = Schema.encodeSync(Sandbox)(leased)
      expect(encoded.state).toEqual({
        _tag: "Leased",
        holder: "agent-a",
        startedAt: "2026-10-16T08:00:00.000Z",
        endsAt: "2026-10-16T16:00:00.000Z"
      })
      expect(decode(encoded)).toEqual(leased)
      expect(() => decode({ ...encoded, accountId: "12" })).toThrow()
      expect(() => decode({ ...encoded, name: "" })).toThrow()
    }))
})
