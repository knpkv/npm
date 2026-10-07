#!/usr/bin/env node
/**
 * CLI entry point for jcf — assembles root command and runs via `NodeRuntime.runMain`.
 *
 * @module
 */
import { NodeRuntime } from "@effect/platform-node"
import { Console, Data, Effect } from "effect"
import { Command } from "effect/cli"
import * as Runtime from "effect/Runtime"
import * as Stdio from "effect/Stdio"
import pkg from "../package.json" with { type: "json" }
import { HeadlessLayer } from "./cli/layers.js"
import { commandNames, root } from "./cli/root.js"
import { reportUnhandled } from "./cli/runtimeFailure.js"
import { unknownCommandLine } from "./cli/unknownCommand.js"

const processArgv = Effect.gen(function*() {
  const stdio = yield* Stdio.Stdio
  const args = yield* stdio.args
  return args
})

const cli = Command.runWith(root, { version: pkg.version })

/** An unknown command fails with one line, before effect/cli prints the whole help above it. */
class UnknownCommand extends Data.TaggedError("UnknownCommand")<{}> {
  override readonly [Runtime.errorReported] = false
}

const program = reportUnhandled(processArgv.pipe(
  Effect.flatMap((argv) =>
    Effect.gen(function*() {
      const unknown = unknownCommandLine(argv, commandNames)
      if (unknown !== undefined) {
        yield* Console.error(unknown)
        return yield* new UnknownCommand()
      }
      return yield* cli(argv)
    })
  )
)).pipe(
  // This *is* the entry point: the one place the whole layer graph is composed and provided.
  // @effect-diagnostics-next-line strictEffectProvide:off
  Effect.provide(HeadlessLayer)
)

// The TUI keeps long-lived resources open through its atom runtime, and OpenTUI
// holds stdin in raw mode so Ctrl-C arrives as a keypress, not a SIGINT. On a
// clean in-app quit (exit code 0) runMain's default teardown never reaches
// `process.exit`, leaving the process hanging on those open handles after the
// UI tears down. This bin also runs as the Bun child re-spawned from the Node
// parent, so both processes need the explicit exit. Always terminate.
const forceExitTeardown: Runtime.Teardown = (exit) => Runtime.defaultTeardown(exit, (code) => process.exit(code))

// The command boundary above renders unreported failures once. Runtime reporting stays disabled so
// it cannot add a second stack trace after that concise diagnostic.
NodeRuntime.runMain(program, { disableErrorReporting: true, teardown: forceExitTeardown })
