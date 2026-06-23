#!/usr/bin/env node
/**
 * CLI entry point for jcf — assembles root command and runs via `NodeRuntime.runMain`.
 *
 * @module
 */
import { NodeRuntime, NodeStdio } from "@effect/platform-node"
import { Effect } from "effect"
import * as Stdio from "effect/Stdio"
import { Command } from "effect/unstable/cli"
import { auth } from "./cli/auth.js"
import { config } from "./cli/config.js"
import { HeadlessLayer } from "./cli/layers.js"
import { list } from "./cli/list.js"
import { launchTuiOrSetup } from "./cli/setup.js"
import { discard, edit, log, start, statusCmd, stop } from "./cli/timer.js"

const processArgv = Effect.gen(function*() {
  const stdio = yield* Stdio.Stdio
  const args = yield* stdio.args
  return args
})

const tui = Command.make("tui", {}, () => processArgv.pipe(Effect.flatMap(launchTuiOrSetup)))

const root = Command.make("jcf", {}, () => processArgv.pipe(Effect.flatMap(launchTuiOrSetup))).pipe(
  Command.withSubcommands([tui, auth, start, stop, discard, log, statusCmd, list, config, edit])
)

const cli = Command.runWith(root, {
  version: "0.1.0"
})

const program = processArgv.pipe(
  Effect.flatMap((argv) => cli(argv)),
  Effect.provide(HeadlessLayer),
  Effect.provide(NodeStdio.layer)
)

NodeRuntime.runMain(program as Effect.Effect<void, unknown, never>)
