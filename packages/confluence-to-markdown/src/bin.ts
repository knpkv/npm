#!/usr/bin/env node
/**
 * CLI entry point for confluence-to-markdown.
 */
import { NodeRuntime, NodeStdio, NodeTerminal } from "@effect/platform-node"
import { makeInstallCommand } from "@knpkv/agent-skills"
import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import * as Stdio from "effect/Stdio"
import { Command } from "effect/unstable/cli"
import pkg from "../package.json" with { type: "json" }
import { handleError } from "./commands/errorHandler.js"
import {
  authCommand,
  cloneCommand,
  commitCommand,
  deleteCommand,
  diffCommand,
  logCommand,
  newCommand,
  pullCommand,
  pushCommand,
  statusCommand
} from "./commands/index.js"
import { AppLayer, AuthOnlyLayer, CloneLayer, getLayerType, MinimalLayer } from "./commands/layers.js"

const skillsInstall = makeInstallCommand({
  description: "Install the Confluence agent skill",
  name: "install",
  skills: ["confluence"]
})

const skillsCommand = Command.make("skills", {}, () => Console.log("Usage: confluence skills install")).pipe(
  Command.withDescription("Agent skill commands"),
  Command.withSubcommands([skillsInstall])
)

// === Main command ===
const confluence = Command.make("confluence").pipe(
  Command.withDescription("Sync Confluence pages to local markdown"),
  Command.withSubcommands([
    cloneCommand,
    authCommand,
    pullCommand,
    pushCommand,
    statusCommand,
    commitCommand,
    logCommand,
    diffCommand,
    newCommand,
    deleteCommand,
    skillsCommand
  ])
)

// === Run CLI ===
const cli = Command.runWith(confluence, {
  version: pkg.version
})

const layerForArgv = (argv: ReadonlyArray<string>) => {
  const layerType = getLayerType(argv)
  return layerType === "full"
    ? AppLayer
    : layerType === "auth"
    ? AuthOnlyLayer
    : layerType === "clone"
    ? CloneLayer
    : MinimalLayer
}

// Suppress verbose Effect logs (e.g. token refresh messages)
Effect.gen(function*() {
  const stdio = yield* Stdio.Stdio
  const args = yield* stdio.args
  return yield* cli(args).pipe(
    Effect.provide(layerForArgv(args))
  )
}).pipe(
  Effect.provide(NodeTerminal.layer),
  Effect.provide(NodeStdio.layer),
  Effect.catchCause((cause) => handleError(cause)),
  NodeRuntime.runMain({ disableErrorReporting: true })
)
