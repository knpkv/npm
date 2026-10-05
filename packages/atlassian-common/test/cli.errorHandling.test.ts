/** @effect-diagnostics strictEffectProvide:skip-file */
/**
 * How every Atlassian CLI reports a failed run: the message by default, the full cause when asked,
 * nothing for what `Command.runWith` already rendered, and the exit unchanged.
 */
import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { ConfigProvider } from "effect"
import * as Cause from "effect/Cause"
import { Argument, CliError, Command } from "effect/cli"
import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Schema from "effect/Schema"
import * as Stdio from "effect/Stdio"
import {
  commandArgs,
  handleCliError,
  Verbose,
  verboseFlagIn,
  verboseRequested,
  withCliErrorHandling
} from "../src/cli/index.js"

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
  // The scanner runs before the CLI parses, so it must agree with the parser it stands in for.
  const parsed = (args: ReadonlyArray<string>) =>
    Effect.gen(function*() {
      const seen: Array<boolean> = []
      const probe = Command.make("probe", { words: Argument.String("word").pipe(Argument.variadic()) }, () =>
        Effect.gen(function*() {
          seen.push(yield* Verbose)
        }))
      const root = Command.make("tool").pipe(Command.withSubcommands([probe]), Command.withGlobalFlags([Verbose]))
      const exit = yield* Command.runWith(root, { version: "0" })(args).pipe(
        Effect.provide(NodeServices.layer),
        Effect.exit
      )
      return { exit, verbose: seen[0] }
    })

  it.effect("reads --verbose and routes the command words exactly as the parser does", () =>
    Effect.gen(function*() {
      const cases: ReadonlyArray<ReadonlyArray<string>> = [
        ["probe", "x"],
        ["--verbose", "probe", "x"],
        ["--verbose", "false", "probe", "x"],
        ["--verbose", "true", "probe", "x"],
        ["--verbose=false", "probe", "x"],
        ["--verbose=yes", "probe", "x"],
        ["probe", "x", "--verbose"],
        ["--verbose", "--no-verbose", "probe", "x"],
        ["--no-verbose", "--verbose", "probe", "x"],
        ["probe", "--", "--verbose"]
      ]
      for (const args of cases) {
        const { exit, verbose } = yield* parsed(args)
        expect(Exit.isSuccess(exit), JSON.stringify(args)).toBe(true)
        expect(verboseFlagIn(args), JSON.stringify(args)).toBe(verbose)
        expect(commandArgs(args)[0], JSON.stringify(args)).toBe("probe")
      }
    }))

  it.effect("does not report verbose for a value the parser rejects, and the rejection is printed", () =>
    Effect.gen(function*() {
      expect(verboseFlagIn(["--verbose=bogus", "probe"])).toBe(false)
      const { exit } = yield* parsed(["--verbose=bogus", "probe", "x"])
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const lines = yield* stderrOf(exit.cause, false)
        expect(lines).toHaveLength(1)
        expect(lines[0]).toContain("bogus")
      }
    }))

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
