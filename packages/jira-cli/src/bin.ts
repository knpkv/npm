#!/usr/bin/env node
/**
 * CLI entry point — assembles commands, selects layer by subcommand, runs via `NodeRuntime`.
 *
 * Arguments are read from Effect's `Stdio` service at the runtime edge.
 *
 * @module
 */
import { NodeRuntime, NodeStdio } from "@effect/platform-node"
import * as Effect from "effect/Effect"
import * as Stdio from "effect/Stdio"
import { Command } from "effect/unstable/cli"
import pkg from "../package.json" with { type: "json" }
import {
  AppLayer,
  authCommand,
  AuthOnlyLayer,
  getCommand,
  getLayerType,
  handleError,
  MinimalLayer,
  searchCommand,
  versionCommand
} from "./commands/index.js"

// === Main command ===
const jira = Command.make("jira").pipe(
  Command.withDescription("Fetch Jira tickets and export to markdown"),
  Command.withSubcommands([
    authCommand,
    getCommand,
    searchCommand,
    versionCommand
  ])
)

// === Run CLI ===
const cli = Command.runWith(jira, {
  version: pkg.version
})

const program = Effect.gen(function*() {
  const stdio = yield* Stdio.Stdio
  const args = yield* stdio.args
  const layerType = getLayerType(args)
  const layer = layerType === "full"
    ? AppLayer
    : layerType === "auth"
    ? AuthOnlyLayer
    : MinimalLayer

  return yield* cli(args).pipe(
    Effect.provide(layer)
  )
}).pipe(
  Effect.provide(NodeStdio.layer),
  Effect.catchCause((cause) => handleError(cause))
)

NodeRuntime.runMain(program as unknown as Effect.Effect<void, unknown, never>)
