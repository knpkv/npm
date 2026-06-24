#!/usr/bin/env node
/**
 * CLI entry point — assembles commands, selects layer by subcommand, runs via `NodeRuntime`.
 *
 * Arguments are read from Effect's `Stdio` service at the runtime edge.
 *
 * @module
 */
import { NodeRuntime, NodeStdio } from "@effect/platform-node"
import { makeInstallCommand } from "@knpkv/agent-skills"
import * as Console from "effect/Console"
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

const skillsInstall = makeInstallCommand({
  description: "Install the Jira agent skill",
  name: "install",
  skills: ["jira"]
})

const skillsCommand = Command.make("skills", {}, () => Console.log("Usage: jira skills install")).pipe(
  Command.withDescription("Agent skill commands"),
  Command.withSubcommands([skillsInstall])
)

// === Main command ===
const jira = Command.make("jira").pipe(
  Command.withDescription("Fetch Jira tickets and export to markdown"),
  Command.withSubcommands([
    authCommand,
    getCommand,
    searchCommand,
    skillsCommand,
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

NodeRuntime.runMain(program)
