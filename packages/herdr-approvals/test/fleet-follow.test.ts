import { describe, expect, it } from "@effect/vitest"
import type { JobRecord } from "@knpkv/herdr-fleet"
import { Deferred, Effect, Fiber } from "effect"
import { TestClock } from "effect/testing"
import { followJob } from "../src/internal/fleet-follow.js"

const record = (status: JobRecord["status"]): JobRecord => ({
  actor: "local",
  approvalExpiresAt: null,
  approvalNonce: null,
  approvedAt: null,
  approvedBy: null,
  createdAt: 1,
  error: null,
  expiredAt: null,
  hash: "hash",
  id: "job-1",
  payload: { kind: "nix.check" },
  rejectedAt: null,
  rejectedBy: null,
  result: status === "succeeded" ? "ok" : null,
  status,
  updatedAt: 1
})

describe("fleet follow polling", () => {
  it.effect("returns the observed terminal record without another request", () =>
    Effect.gen(function*() {
      const firstObserved = yield* Deferred.make<void>()
      let requests = 0
      const poll = Effect.suspend(() => {
        requests += 1
        if (requests === 1) {
          return Deferred.succeed(firstObserved, undefined).pipe(
            Effect.as(record("running"))
          )
        }
        if (requests === 2) return Effect.succeed(record("succeeded"))
        return Effect.die("follow polled after observing terminal state")
      })
      const fiber = yield* Effect.forkChild(followJob(poll))
      yield* Deferred.await(firstObserved)
      yield* TestClock.adjust("1 second")
      expect(yield* Fiber.join(fiber)).toMatchObject({
        result: "ok",
        status: "succeeded"
      })
      expect(requests).toBe(2)
    }))
})
