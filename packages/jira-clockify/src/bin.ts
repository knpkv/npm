#!/usr/bin/env node
/**
 * CLI entry point for jcf — assembles root command and runs via `NodeRuntime.runMain`.
 *
 * @module
 */
import { NodeRuntime, NodeStdio } from "@effect/platform-node"
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
  Effect.provide(HeadlessLayer),
  Effect.provide(NodeStdio.layer)
)

// The TUI keeps long-lived resources open through its atom runtime, and OpenTUI
// holds stdin in raw mode so Ctrl-C arrives as a keypress, not a SIGINT. On a
// clean in-app quit (exit code 0) runMain's default teardown never reaches
// `process.exit`, leaving the process hanging on those open handles after the
// UI tears down. This bin also runs as the Bun child re-spawned from the Node
// parent, so both processes need the explicit exit. Always terminate.
const forceExitTeardown: Runtime.Teardown = (exit) => Runtime.defaultTeardown(exit, (code) => process.exit(code))

NodeRuntime.runMain(program, { teardown: forceExitTeardown })
