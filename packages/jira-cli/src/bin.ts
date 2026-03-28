#!/usr/bin/env node
/**
 * CLI entry point — assembles commands, selects layer by subcommand, runs via `NodeRuntime`.
 *
 * `process.argv` is read once at the edge and passed to Effect — no globals in effectful code.
 *
 * @module
 */
import { Command } from "@effect/cli"
import { NodeRuntime } from "@effect/platform-node"
import * as Effect from "effect/Effect"
import * as Logger from "effect/Logger"
import * as LogLevel from "effect/LogLevel"
import pkg from "../package.json" with { type: "json" }
import {
  AppLayer,
  authCommand,
  AuthOnlyLayer,
  getCommand,
  getLayerType,
  handleError,
  MinimalLayer,
  searchCommand
} from "./commands/index.js"

// === Main command ===
const jira = Command.make("jira").pipe(
  Command.withDescription("Fetch Jira tickets and export to markdown"),
  Command.withSubcommands([
    authCommand,
    getCommand,
    searchCommand
  ])
)

// === Run CLI ===
const cli = Command.run(jira, {
  name: pkg.name,
  version: pkg.version
})

// Read argv once at the edge
const argv = globalThis.process.argv

const layerType = getLayerType(argv)
const layer = layerType === "full"
  ? AppLayer
  : layerType === "auth"
  ? AuthOnlyLayer
  : MinimalLayer

// Suppress verbose Effect logs
const SilentLogger = Logger.replace(Logger.defaultLogger, Logger.none)

const program = cli(argv).pipe(
  Effect.provide(layer),
  Effect.provide(SilentLogger),
  Logger.withMinimumLogLevel(LogLevel.None),
  Effect.catchAllCause((cause) => handleError(cause))
)

NodeRuntime.runMain(program)
