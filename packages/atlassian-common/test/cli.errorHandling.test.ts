/** @effect-diagnostics strictEffectProvide:skip-file */
/**
 * How every Atlassian CLI reports a failed run: the message by default, the full cause when asked,
 * nothing for what `Command.runWith` already rendered, and the exit unchanged.
 */
import { describe, expect, it } from "@effect/vitest"
import { ConfigProvider } from "effect"
import * as Cause from "effect/Cause"
import { CliError } from "effect/cli"
import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Schema from "effect/Schema"
import * as Stdio from "effect/Stdio"
import { commandArgs, handleCliError, verboseFlagIn, verboseRequested, withCliErrorHandling } from "../src/cli/index.js"

class ProfileGone extends Schema.TaggedError<ProfileGone>()("ProfileGone", { message: Schema.String }) {}
class Bare extends Schema.TaggedError<Bare>()("Bare", {}) {}

const stderrOf = <E>(cause: Cause.Cause<E>, verbose: boolean) =>
  Effect.gen(function*() {
    const lines: Array<string> = []
    const capture: Console.Console = Object.assign(Object.create(console), {
      error: (...parts: ReadonlyArray<unknown>) => lines.push(parts.join(" "))
    })
    yield* handleCliError(cause, { verbose }).pipe(Effect.provideService(Console.Console, capture))
    return lines
  })

describe("handleCliError", () => {
  it.effect("prints a failure's message, a bare tagged error's tag, a defect and an interruption", () =>
    Effect.gen(function*() {
      expect(yield* stderrOf(Cause.fail(new ProfileGone({ message: "Profile not found: x" })), false)).toEqual([
        "Profile not found: x"
      ])
      expect(yield* stderrOf(Cause.fail(new Bare()), false)).toEqual(["Bare"])
      expect(yield* stderrOf(Cause.die(new Error("boom")), false)).toEqual(["Error: boom"])
      expect(yield* stderrOf(Cause.interrupt(), false)).toEqual(["Interrupted"])
    }))

  it.effect("skips what Command.runWith already rendered", () =>
    Effect.gen(function*() {
      const help = new CliError.ShowHelp({ commandPath: ["jira"], errors: [] })
      expect(yield* stderrOf(Cause.fail(help), false)).toEqual([])
    }))

  it.effect("prints the full cause, stack included, when verbose", () =>
    Effect.gen(function*() {
      const lines = yield* stderrOf(Cause.die(new Error("boom")), true)
      expect(lines.join("\n")).toContain("boom")
      expect(lines.join("\n")).toContain("at ")
    }))
})

describe("verbose", () => {
  it("reads --verbose the way the flag parses it", () => {
    const cases: ReadonlyArray<readonly [ReadonlyArray<string>, boolean]> = [
      [["--verbose"], true],
      [["auth", "use", "x", "--verbose"], true],
      [["--verbose=true"], true],
      [["--verbose=false"], false],
      [["--verbose", "--no-verbose"], false],
      [["--", "--verbose"], false],
      [["--verbosely"], false],
      [[], false]
    ]
    for (const [args, expected] of cases) expect(verboseFlagIn(args), JSON.stringify(args)).toBe(expected)
  })

  it("routes on the command words with --verbose removed, leaving everything after --", () => {
    expect(commandArgs(["--verbose", "auth", "use", "x"])).toEqual(["auth", "use", "x"])
    expect(commandArgs(["auth", "--verbose=false", "status"])).toEqual(["auth", "status"])
    expect(commandArgs(["page", "get", "--", "--verbose"])).toEqual(["page", "get", "--", "--verbose"])
  })

  it.effect("turns on for DEBUG=1 only", () =>
    Effect.gen(function*() {
      const withEnv = (env: Record<string, string>) =>
        verboseRequested([]).pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))))
      expect(yield* withEnv({ DEBUG: "1" })).toBe(true)
      expect(yield* withEnv({ DEBUG: "express:*" })).toBe(false)
      expect(yield* withEnv({})).toBe(false)
    }))

  it.effect("reports with --verbose from the arguments, and fails with the same cause", () =>
    Effect.gen(function*() {
      const lines: Array<string> = []
      const capture: Console.Console = Object.assign(Object.create(console), {
        error: (...parts: ReadonlyArray<unknown>) => lines.push(parts.join(" "))
      })
      const failure = new ProfileGone({ message: "Profile not found: x" })
      const exit = yield* withCliErrorHandling(Effect.fail(failure)).pipe(
        Effect.provideService(Console.Console, capture),
        Effect.provide(Stdio.layerTest({ args: Effect.succeed(["auth", "use", "x", "--verbose"]) })),
        Effect.exit
      )
      expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toBe(failure)
      expect(lines.join("\n")).toContain("ProfileGone")
    }))
})
