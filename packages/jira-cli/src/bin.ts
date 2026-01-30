#!/usr/bin/env node
/**
 * CLI entry point for jira-cli.
 *
 * @module
 */
import { Command } from "@effect/cli"
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

const layerType = getLayerType()
const layer = layerType === "full"
  ? AppLayer
  : layerType === "auth"
  ? AuthOnlyLayer
  : MinimalLayer

// Suppress verbose Effect logs
const SilentLogger = Logger.replace(Logger.defaultLogger, Logger.none)

const program = Effect.suspend(() => cli(process.argv)).pipe(
  Effect.provide(layer),
  Effect.provide(SilentLogger),
  Logger.withMinimumLogLevel(LogLevel.None)
)

Effect.runPromiseExit(program).then((exit) => {
  if (exit._tag === "Failure") {
    handleError(exit.cause)
    process.exit(1)
  }
})
