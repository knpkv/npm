#!/usr/bin/env node
/**
 * CLI entry point for confluence-to-markdown.
 */
import { Command } from "@effect/cli"
import * as Effect from "effect/Effect"
import pkg from "../package.json" with { type: "json" }
import { handleError } from "./commands/errorHandler.js"
import {
  authCommand,
  cloneCommand,
  commitCommand,
  diffCommand,
  logCommand,
  pullCommand,
  pushCommand,
  statusCommand
} from "./commands/index.js"
import { AppLayer, AuthOnlyLayer, CloneLayer, getLayerType, MinimalLayer } from "./commands/layers.js"

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
    diffCommand
  ])
)

// === Run CLI ===
const cli = Command.run(confluence, {
  name: pkg.name,
  version: pkg.version
})

const layerType = getLayerType()
const layer = layerType === "full"
  ? AppLayer
  : layerType === "auth"
  ? AuthOnlyLayer
  : layerType === "clone"
  ? CloneLayer
  : MinimalLayer

Effect.suspend(() => cli(process.argv)).pipe(
  Effect.provide(layer),
  Effect.runPromiseExit
).then((exit) => {
  if (exit._tag === "Failure") {
    handleError(exit.cause)
    process.exit(1)
  }
})
