import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { Command } from "effect/unstable/cli"
import { HeadlessLayer } from "../src/cli/layers.js"
import { root } from "../src/cli/root.js"
import { reportUnhandled } from "../src/cli/runtimeFailure.js"
import { ReconcileError } from "../src/services/ReconcileService.js"
import { makeFakeHeadless } from "../src/testing/fakeHeadless.js"

// A test case is its own entry point: it composes exactly the layers that case needs and
// provides them there. Both provide diagnostics are about production wiring, where a Layer
// provided mid-graph can cut a scope short.
// @effect-diagnostics strictEffectProvide:off
// @effect-diagnostics multipleEffectProvide:off

const run = (args: ReadonlyArray<string>) =>
  Command.runWith(root, { version: "0.0.0-test" })(args).pipe(
    Effect.provide(HeadlessLayer),
    Effect.exit
  )

describe("jcf command surface", () => {
  const canonicalCommands: ReadonlyArray<ReadonlyArray<string>> = [
    ["timer"],
    ["timer", "start", "--help"],
    ["timer", "stop", "--help"],
    ["timer", "discard", "--help"],
    ["timer", "status", "--help"],
    ["timer", "log", "--help"],
    ["timer", "edit", "--help"],
    ["issue", "list", "--help"],
    ["sync", "reconcile", "--help"],
    ["watch", "--help"],
    ["config", "set", "session-root", "--help"],
    ["config", "set", "session-ticket", "--help"],
    ["config", "set", "idle-cap", "--help"]
  ]

  for (const args of canonicalCommands) {
    it.effect(`accepts canonical command: jcf ${args.join(" ")}`, () =>
      Effect.gen(function*() {
        const exit = yield* run(args)

        expect(exit._tag).toBe("Success")
      }))
  }

  const legacyCommands: ReadonlyArray<ReadonlyArray<string>> = [
    ["start"],
    ["stop"],
    ["discard"],
    ["status"],
    ["log"],
    ["edit"],
    ["list"],
    ["reconcile"]
  ]

  for (const args of legacyCommands) {
    it.effect(`rejects removed legacy command: jcf ${args.join(" ")}`, () =>
      Effect.gen(function*() {
        const exit = yield* run(args)

        expect(exit._tag).toBe("Failure")
      }))
  }

  it.effect("reports an unhandled timer safety-read failure before exiting", () =>
    Effect.gen(function*() {
      const fake = makeFakeHeadless({ clockifyRunningTimerReadFails: true })
      const exit = yield* reportUnhandled(
        Command.runWith(root, { version: "0.0.0-test" })(["timer", "start", "PROJ-1"])
      ).pipe(
        Effect.provide(fake.layer),
        Effect.exit
      )

      expect(exit._tag).toBe("Failure")
      expect(fake.world.stderr.join("\n")).toContain("Could not check for a running Clockify timer")
    }))

  it.effect("reports a propagated pre-write refresh failure", () =>
    Effect.gen(function*() {
      const fake = makeFakeHeadless()
      const exit = yield* reportUnhandled(
        Effect.fail(new ReconcileError({ message: "Could not refresh providers before writing" }))
      ).pipe(
        Effect.provide(fake.layer),
        Effect.exit
      )

      expect(exit._tag).toBe("Failure")
      expect(fake.world.stderr).toEqual(["Could not refresh providers before writing"])
    }))

  it.effect("does not print an already-reported usage failure twice", () =>
    Effect.gen(function*() {
      const fake = makeFakeHeadless()
      const exit = yield* reportUnhandled(
        Command.runWith(root, { version: "0.0.0-test" })(["watch", "codex"])
      ).pipe(
        Effect.provide(fake.layer),
        Effect.exit
      )

      expect(exit._tag).toBe("Failure")
      expect(fake.world.stderr.filter((line) => line.includes("Unsupported agent"))).toHaveLength(1)
    }))
})
