#!/usr/bin/env node
/**
 * CLI entry point for jcf — assembles root command and runs via `NodeRuntime.runMain`.
 *
 * @module
 */
import { NodeRuntime } from "@effect/platform-node"
import { Effect } from "effect"
import * as Runtime from "effect/Runtime"
import * as Stdio from "effect/Stdio"
import { Command } from "effect/unstable/cli"
import { HeadlessLayer } from "./cli/layers.js"
import { root } from "./cli/root.js"

const processArgv = Effect.gen(function*() {
  const stdio = yield* Stdio.Stdio
  const args = yield* stdio.args
  return args
})

const cli = Command.runWith(root, {
  version: "0.1.0"
})

const program = processArgv.pipe(
  Effect.flatMap((argv) => cli(argv)),
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

// Error reporting off: commands print their own failures in the user's terms before re-failing, so
// the runtime's second report would only add a stack trace to a message already shown. Matches the
// convention the other CLIs in this repo follow.
NodeRuntime.runMain(program, { disableErrorReporting: true, teardown: forceExitTeardown })
