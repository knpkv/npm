import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { Command } from "effect/unstable/cli"
import { HeadlessLayer } from "../src/cli/layers.js"
import { root } from "../src/cli/root.js"

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
})
