#!/usr/bin/env node
/**
 * CLI entry point for confluence-to-markdown.
 */
import { NodeRuntime, NodeStdio, NodeTerminal } from "@effect/platform-node"
import * as Effect from "effect/Effect"
import * as Stdio from "effect/Stdio"
import { Command } from "effect/unstable/cli"
import pkg from "../package.json" with { type: "json" }
import { handleError } from "./commands/errorHandler.js"
import { AppLayer, AuthOnlyLayer, CloneLayer, FetchLayer, getLayerType, MinimalLayer } from "./commands/layers.js"
import { confluenceCommand } from "./commands/root.js"

// === Run CLI ===
const cli = Command.runWith(confluenceCommand, {
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
    : layerType === "fetch"
    ? FetchLayer
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
