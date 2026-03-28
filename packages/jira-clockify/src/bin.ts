#!/usr/bin/env node
/**
 * CLI entry point for jcf — assembles root command and runs via `NodeRuntime.runMain`.
 *
 * @module
 */
import { Command } from "@effect/cli"
import { NodeRuntime } from "@effect/platform-node"
import { Effect, Logger, LogLevel } from "effect"
import nodeProcess from "node:process"
import { auth } from "./cli/auth.js"
import { config } from "./cli/config.js"
import { HeadlessLayer } from "./cli/layers.js"
import { list } from "./cli/list.js"
import { launchTuiOrSetup } from "./cli/setup.js"
import { discard, edit, log, start, statusCmd, stop } from "./cli/timer.js"

// Capture argv once at the edge — only Node process usage in the codebase
const argv = nodeProcess.argv

const tui = Command.make("tui", {}, () => launchTuiOrSetup(argv))

const root = Command.make("jcf", {}, () => launchTuiOrSetup(argv)).pipe(
  Command.withSubcommands([tui, auth, start, stop, discard, log, statusCmd, list, config, edit])
)

const cli = Command.run(root, {
  name: "jcf",
  version: "0.1.0"
})

// @effect/cli provides --log-level built-in (none, debug, info, warning, error)
// Default to suppressing logs; use --log-level debug for verbose output
Effect.suspend(() => cli(argv)).pipe(
  Logger.withMinimumLogLevel(LogLevel.Warning),
  Effect.provide(HeadlessLayer),
  NodeRuntime.runMain
)
