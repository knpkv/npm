import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { sandboxPayload } from "../src/internal/fleetctl-cli.js"

describe("fleetctl sandbox payloads", () => {
  it.effect("parses each sandbox kind's arguments; the holder is never an argument", () =>
    Effect.gen(function*() {
      expect(yield* sandboxPayload("sandbox.lease", ["sandbox.lease"])).toEqual({ kind: "sandbox.lease" })
      expect(yield* sandboxPayload("sandbox.extend", ["sandbox.extend", "111111111111"])).toEqual({
        kind: "sandbox.extend",
        accountId: "111111111111"
      })
      expect(yield* sandboxPayload("sandbox.reset", ["sandbox.reset", "111111111111", "Retry"])).toEqual({
        kind: "sandbox.reset",
        accountId: "111111111111",
        reason: "Retry"
      })
      expect(yield* sandboxPayload("sandbox.budget.lift", ["sandbox.budget.lift", "111111111111"])).toEqual({
        kind: "sandbox.budget.lift",
        accountId: "111111111111"
      })
    }))

  it.effect("refuses extra or missing arguments, a bad account and an internal reset reason", () =>
    Effect.gen(function*() {
      const refused = (kind: Parameters<typeof sandboxPayload>[0], args: ReadonlyArray<string>) =>
        Effect.flip(sandboxPayload(kind, args)).pipe(Effect.map((error) => error._tag))
      expect(yield* refused("sandbox.lease", ["sandbox.lease", "agent-b"])).toBe("FleetValidationError")
      expect(yield* refused("sandbox.release", ["sandbox.release"])).toBe("FleetValidationError")
      expect(yield* refused("sandbox.extend", ["sandbox.extend", "12"])).toBe("FleetValidationError")
      expect(yield* refused("sandbox.reset", ["sandbox.reset", "111111111111", "Released"])).toBe(
        "FleetValidationError"
      )
      expect(yield* refused("sandbox.reset", ["sandbox.reset", "111111111111"])).toBe("FleetValidationError")
    }))
})
