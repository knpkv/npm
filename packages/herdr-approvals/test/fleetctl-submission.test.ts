import { describe, expect, it } from "@effect/vitest"
import { FleetOperationError, type JobRecord } from "@knpkv/herdr-fleet"
import { Effect } from "effect"
import { submitToHost } from "../src/fleetctl-submission.js"

const pending: JobRecord = {
  actor: "andrey@example.com",
  approvalExpiresAt: 61_000,
  approvalNonce: "nonce-1",
  approvedAt: null,
  approvedBy: null,
  createdAt: 1_000,
  error: null,
  expiredAt: null,
  hash: "hash-1",
  id: "job-1",
  payload: { kind: "nix.apply", ref: "main" },
  rejectedAt: null,
  rejectedBy: null,
  result: null,
  status: "pending_approval",
  updatedAt: 1_000
}

const failure = (operation: string) =>
  new FleetOperationError({
    cause: operation,
    detail: `${operation} failed`,
    operation
  })

describe("fleetctl host submission", () => {
  it.effect("retains a created job when approval URL discovery fails", () =>
    Effect.gen(function*() {
      const outcome = yield* submitToHost(
        "SER8",
        Effect.succeed(pending),
        Effect.fail(failure("approval-url"))
      )
      expect(outcome).toEqual({
        approvalUrl: null,
        approvalUrlError: "approval-url failed",
        host: "SER8",
        record: pending
      })
    }))

  it.effect("retains both the job and approval URL when both succeed", () =>
    Effect.gen(function*() {
      const outcome = yield* submitToHost(
        "SER8",
        Effect.succeed(pending),
        Effect.succeed("https://ser8.example.test/")
      )
      expect(outcome).toEqual({
        approvalUrl: "https://ser8.example.test/",
        approvalUrlError: null,
        host: "SER8",
        record: pending
      })
    }))
})
